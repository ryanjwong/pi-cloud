import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  type ConversationId,
  type Cursor,
  ROOT_CONVERSATION_ID,
  type Storage,
  type SubmissionId
} from "@earendil-works/pi-durable"
import type { JsonValue } from "@earendil-works/chord"
import {
  type Binding,
  BindingStore,
  ControlPlaneConfig,
  type ControlPlaneSettings,
  EventHub,
  LeaseManager,
  RepositoryAccess,
  SessionStore,
  StateStore,
  storageFailure,
  type StreamPosition
} from "@pi-cloud/core"
import {
  CommandFailed,
  type CommandResult,
  ConversationBusy,
  type EventBatch,
  OPERATOR_ONLY,
  type Resolved,
  RunnerUnavailable,
  type SandboxTemplate,
  Session,
  SessionId,
  SessionNotFound,
  type SessionCommand,
  type SessionSpec,
  type SessionView,
  SpecRejected
} from "@pi-cloud/protocol"
import { Clock, Context, Effect, Layer, Option, Semaphore, type Stream } from "effect"
import { Runners } from "./Runners.ts"

export const toJson = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url")
const decodeCursor = (cursor: string): Cursor => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))

export type CommandError = SessionNotFound | RunnerUnavailable | ConversationBusy | CommandFailed

export interface Trust {
  readonly repository?: string | undefined
  readonly thread?: number | undefined
  readonly untrusted?: boolean | undefined
}

export interface CreateInput extends Trust {
  readonly title?: string | undefined
  readonly spec?: SessionSpec | undefined
}

export interface BindingInit extends CreateInput {
  readonly source?: string | undefined
  readonly target?: JsonValue | undefined
}

const GITHUB_REPOSITORY = /^(?:https:\/\/|git@)github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
const githubName = (url: string | undefined) => {
  const name = GITHUB_REPOSITORY.exec(url ?? "")?.[1]?.toLowerCase()
  return name?.split("/").some((part) => /^\.+$/.test(part)) ? undefined : name
}
const repositoryName = (url: string) => githubName(url) ?? url.toLowerCase()

export const resolveSpec = (
  spec: SessionSpec,
  settings: Pick<ControlPlaneSettings, "templates" | "defaultSandbox">,
  trust: Trust = {}
): Effect.Effect<Resolved, SpecRejected, RepositoryAccess> =>
  Effect.gen(function*() {
    const reject = (field: string, reason: string) => Effect.fail(new SpecRejected({ field, reason }))
    if (spec.plugins !== undefined) return yield* reject("plugins", "plugins are configured by the operator")
    if (spec.metadata?.["github"] !== undefined) return yield* reject("metadata.github", "only the server binds a repository")
    const sandboxes: Record<string, SandboxTemplate> = { ...settings.templates }
    let repository = trust.repository?.toLowerCase()
    for (const [name, request] of Object.entries(spec.sandboxes ?? {})) {
      const field = `sandboxes.${name}`
      const operatorOnly = OPERATOR_ONLY.find((key) => request[key] !== undefined)
      if (operatorOnly !== undefined) return yield* reject(`${field}.${operatorOnly}`, "only operator templates set this")
      const templateName = request.template ?? settings.defaultSandbox
      if (!Object.hasOwn(settings.templates, templateName)) {
        return yield* reject(`${field}.template`, `no sandbox template named "${templateName}"`)
      }
      const template = settings.templates[templateName]!
      const url = request.repository
      if (url !== undefined && repositoryName(url) !== repository) {
        const allowed = template.repositories ?? []
        const name = githubName(url)
        if (allowed === "installed" && name !== undefined) {
          yield* RepositoryAccess.use((access) => access.check(name)).pipe(Effect.catchTag("RepositoryRefused", ({ reason }) => reject(`${field}.repository`, reason)))
        } else if (allowed === "installed" || !allowed.some((entry) => repositoryName(entry) === repositoryName(url))) {
          return yield* reject(`${field}.repository`, `template "${templateName}" does not allow ${url}`)
        }
      }
      if (request.ref !== undefined && template.allowRef !== true) {
        return yield* reject(`${field}.ref`, `template "${templateName}" does not allow choosing a ref`)
      }
      if (request.cwd !== undefined && (request.cwd.startsWith("/") || request.cwd.split("/").includes(".."))) {
        return yield* reject(`${field}.cwd`, "must be a relative path inside the sandbox")
      }
      const target = url ?? template.repository?.url
      sandboxes[name] = {
        ...template,
        ...(target === undefined
          ? {}
          : { repository: { ...template.repository, url: target, ref: request.ref ?? template.repository?.ref } }),
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        setup: [...(template.setup ?? []), ...(request.setup ?? [])]
      }
    }
    if (spec.sandbox !== undefined && !Object.hasOwn(sandboxes, spec.sandbox)) {
      return yield* reject("sandbox", `no sandbox named "${spec.sandbox}"`)
    }
    const named = [...Object.keys(spec.sandboxes ?? {}), ...(spec.sandbox === undefined ? [] : [spec.sandbox])]
    repository ??= named.map((name) => githubName(sandboxes[name]?.repository?.url)).find((found) => found !== undefined)
    const withoutSecrets = (template: SandboxTemplate) => ({ ...template, secrets: [], credential: undefined })
    return {
      sandboxes: trust.untrusted === true
        ? Object.fromEntries(Object.entries(sandboxes).map(([name, template]) => [name, withoutSecrets(template)]))
        : sandboxes,
      ...(repository === undefined ? {} : { repository }),
      ...(trust.thread === undefined ? {} : { thread: trust.thread }),
      ...(trust.untrusted === true ? { untrusted: true } : {})
    }
  })

export class Sessions extends Context.Service<Sessions, {
  create(input: CreateInput): Effect.Effect<SessionView, SpecRejected>
  list(): Effect.Effect<ReadonlyArray<SessionView>>
  get(id: string): Effect.Effect<SessionView, SessionNotFound>
  remove(id: string): Effect.Effect<void, SessionNotFound>
  command(id: string, command: SessionCommand): Effect.Effect<unknown, CommandError>
  events(id: string, after: StreamPosition | undefined): Effect.Effect<Stream.Stream<EventBatch>, SessionNotFound>
  entries(id: string, query: {
    readonly conversationId?: number | undefined
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
  }): Effect.Effect<{ readonly entries: ReadonlyArray<unknown>; readonly next?: string | undefined }, SessionNotFound>
  conversations(id: string): Effect.Effect<ReadonlyArray<unknown>, SessionNotFound>
  forKey(key: string, init: BindingInit): Effect.Effect<{ readonly binding: Binding; readonly created: boolean }, SpecRejected>
  submission(id: string, submissionId: number): Effect.Effect<unknown, SessionNotFound>
}>()("@pi-cloud/control-plane/Sessions") {
  static readonly layer: Layer.Layer<
    Sessions,
    never,
    SessionStore | StateStore | LeaseManager | EventHub | BindingStore | Runners | ControlPlaneConfig | RepositoryAccess
  > = Layer.effect(
    Sessions,
    Effect.gen(function*() {
      const store = yield* SessionStore
      const states = yield* StateStore
      const leases = yield* LeaseManager
      const runners = yield* Runners
      const hub = yield* EventHub
      const bindings = yield* BindingStore
      const config = yield* ControlPlaneConfig
      const access = yield* RepositoryAccess
      const keyLocks = new Map<string, Semaphore.Semaphore>()
      const keyLock = (key: string) => {
        let lock = keyLocks.get(key)
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1)
          keyLocks.set(key, lock)
        }
        return lock
      }

      const find = Effect.fnUntraced(function*(id: string) {
        const session = yield* store.get(id as SessionId).pipe(Effect.orDie)
        if (Option.isNone(session)) return yield* new SessionNotFound({ sessionId: id })
        return session.value
      })

      const view = Effect.fnUntraced(function*(session: Session) {
        const lease = yield* leases.current(session.id)
        const starting = yield* runners.starting(session.id)
        const runner: SessionView["runner"] = Option.isSome(lease)
          ? { state: "running", runnerId: lease.value.runnerId, leaseExpiresAt: lease.value.expiresAt }
          : { state: starting ? "starting" : "idle" }
        return { id: session.id, title: session.title, spec: session.spec, createdAt: session.createdAt, runner }
      })

      const read = <A>(id: string, f: (storage: Storage) => Promise<A>) =>
        Effect.gen(function*() {
          yield* find(id)
          const storage = yield* states.open(id).pipe(Effect.orDie)
          return yield* Effect.tryPromise({ try: () => f(storage), catch: storageFailure }).pipe(Effect.orDie)
        })

      const settle = (sessionId: string, result: CommandResult): Effect.Effect<unknown, CommandError> => {
        if (result._tag === "Ok") return Effect.succeed(result.value)
        switch (result.tag) {
          case "ConversationBusy":
            return Effect.fail(new ConversationBusy({ sessionId }))
          case "LeaseLost":
            return Effect.fail(new RunnerUnavailable({ sessionId, message: result.message }))
          default:
            return Effect.fail(new CommandFailed({ message: result.message, reason: result.tag }))
        }
      }

      const create = Effect.fnUntraced(function*(input: CreateInput) {
        const spec = input.spec ?? {}
        const session = new Session({
          id: SessionId.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`),
          title: input.title,
          spec,
          resolved: yield* resolveSpec(spec, config, input).pipe(Effect.provideService(RepositoryAccess, access)),
          createdAt: yield* Clock.currentTimeMillis
        })
        yield* store.put(session).pipe(Effect.orDie)
        return yield* view(session)
      })

      const forKey = (thread: string, init: BindingInit) => {
        const key = init.untrusted === true ? `${thread}#untrusted` : thread
        return keyLock(key).withPermits(1)(Effect.gen(function*() {
          const existing = yield* bindings.get(key).pipe(Effect.orDie)
          if (Option.isSome(existing)) {
            const alive = yield* store.get(existing.value.sessionId as SessionId).pipe(Effect.orDie)
            if (Option.isSome(alive) && alive.value.resolved !== undefined) return { binding: existing.value, created: false }
          }
          const session = yield* create({ ...init, title: init.title ?? thread })
          const binding: Binding = {
            key,
            sessionId: session.id,
            source: init.source,
            target: init.target,
            delivered: 0,
            createdAt: yield* Clock.currentTimeMillis
          }
          yield* bindings.put(binding).pipe(Effect.orDie)
          return { binding, created: true }
        }))
      }

      return Sessions.of({
        create,
        forKey,
        list: () => store.list().pipe(Effect.orDie, Effect.flatMap((all) => Effect.forEach(all, view))),
        get: (id) => Effect.flatMap(find(id), view),
        remove: Effect.fnUntraced(function*(id) {
          yield* find(id)
          yield* runners.shutdown(id, "The session was deleted")
          yield* leases.remove(id)
          yield* hub.remove(id)
          yield* states.remove(id).pipe(Effect.orDie)
          yield* store.remove(id as SessionId).pipe(Effect.orDie)
          for (const binding of yield* bindings.list().pipe(Effect.orDie)) {
            if (binding.sessionId === id) yield* bindings.remove(binding.key).pipe(Effect.orDie)
          }
        }),
        command: Effect.fnUntraced(function*(id, command) {
          const session = yield* find(id)
          if (session.resolved === undefined) {
            return yield* new CommandFailed({ message: "This session's spec predates server-side checks and is refused", reason: "SpecRejected" })
          }
          return yield* settle(session.id, yield* runners.send(session, command))
        }),
        events: (id, after) => Effect.map(find(id), () => hub.subscribe(id, after)),
        entries: (id, query) =>
          read(id, async (storage) => {
            const conversationId = (query.conversationId ?? ROOT_CONVERSATION_ID) as ConversationId
            if ((await storage.conversation(conversationId, BACKGROUND_CONTEXT)) === undefined) return { entries: [] }
            const page = await storage.scanEntries(
              { conversationId, order: "ascending" },
              Math.min(query.limit ?? 100, 1000),
              query.cursor === undefined ? undefined : decodeCursor(query.cursor),
              BACKGROUND_CONTEXT
            )
            return {
              entries: toJson(page.items) as ReadonlyArray<unknown>,
              next: page.next === undefined ? undefined : encodeCursor(page.next)
            }
          }),
        conversations: (id) =>
          read(id, async (storage) =>
            toJson((await storage.scanConversations({}, 1000, undefined, BACKGROUND_CONTEXT)).items) as ReadonlyArray<
              unknown
            >),
        submission: (id, submissionId) =>
          read(id, async (storage) =>
            toJson(await storage.submission(submissionId as SubmissionId, BACKGROUND_CONTEXT)) ?? null)
      })
    })
  )
}
