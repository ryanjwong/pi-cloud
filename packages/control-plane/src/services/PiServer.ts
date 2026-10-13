import {
  type Context,
  createRemoteServiceEndpoint,
  isRemoteServiceErrorCode,
  type MutableReplicatedState,
  RemoteServiceError,
  RemoteServiceProvider,
  replicatedState,
  type ServiceProviderUpdate
} from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  type RoutedServerServiceAttachment,
  type RoutedSessionHandle,
  Server,
  type ServerHost,
  type ServerListener,
  SessionNotFoundError
} from "@earendil-works/pi-server"
import { SessionStore } from "@pi-cloud/core"
import {
  type CloudSession,
  CloudSessions,
  type CloudSessionsState,
  type SessionId,
  SessionDirectory,
  type SessionDirectoryState,
  SessionManagement,
  SessionSpec,
  type SessionSummary,
  type SessionView
} from "@pi-cloud/protocol"
import { Context as EffectContext, Deferred, Effect, Layer, Option, Schedule, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { ClientAuth } from "../http/Auth.ts"
import { Runners } from "../Runners.ts"
import { Sessions } from "../Sessions.ts"

/** The WebSocket path of the service API. */
export const SERVICES_PATH = "/v1/pi"

type Publish = (subscriptionId: string, update: ServiceProviderUpdate, context: Context) => unknown

/**
 * The control plane's side of the service API (`Services.ts` in `@pi-cloud/protocol`): Pi's own server
 * (`@earendil-works/pi-server`), so presentations speak Pi's protocol and use `@earendil-works/pi-client`.
 * It serves the server services itself and relays each session's services to the runner hosting the session.
 */
export class PiServer extends EffectContext.Service<PiServer, {
  readonly serverId: string
  /** Route a subscription update from a runner to the attachment it belongs to. */
  publish(attachmentId: string, subscriptionId: string, update: unknown): Effect.Effect<void>
}>()("@pi-cloud/control-plane/PiServer") {
  static readonly layer = (options: { readonly serverId?: string | undefined } = {}) =>
    Layer.effect(PiServer, Effect.gen(function*() {
      const sessions = yield* Sessions
      const runners = yield* Runners
      const store = yield* SessionStore
      const auth = yield* ClientAuth
      const router = yield* HttpRouter.HttpRouter
      const serverId = options.serverId ?? crypto.randomUUID()
      const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

      // Each attachment's subscription updates go back through the publish function of its newest call.
      const publishers = new Map<string, Publish>()

      // ----- Server services: the session directory, management, and pi-cloud's session details.
      const summaryOf = (session: SessionView): SessionSummary => ({ serverId, sessionId: session.id, createdAt: session.createdAt })
      const cloudOf = (session: SessionView): CloudSession => ({
        id: session.id,
        title: session.title ?? null,
        createdAt: session.createdAt,
        spec: JSON.parse(JSON.stringify(session.spec)),
        runner: { state: session.runner.state, runnerId: session.runner.runnerId ?? null }
      })
      const listed = async () => [...await run(sessions.list())].sort((a, b) => a.createdAt - b.createdAt)
      let revision = 1
      const initial = yield* Effect.promise(listed)
      const directory: MutableReplicatedState<SessionDirectoryState> = replicatedState({ revision, sessions: initial.map(summaryOf) })
      const cloud: MutableReplicatedState<CloudSessionsState> = replicatedState({ revision, sessions: initial.map(cloudOf) })
      let lastListing = JSON.stringify(initial.map(cloudOf))
      const refresh = async (context: Context = BACKGROUND_CONTEXT) => {
        const all = await listed()
        const listing = JSON.stringify(all.map(cloudOf))
        if (listing === lastListing) return
        lastListing = listing
        revision += 1
        directory.change(context, (draft) => {
          draft.revision = revision
          draft.sessions = all.map(summaryOf)
        })
        cloud.change(context, (draft) => {
          draft.revision = revision
          draft.sessions = all.map(cloudOf)
        })
      }
      // Sessions also change through REST, triggers and runners; keep the directory current.
      yield* Effect.promise(() => refresh()).pipe(Effect.ignore, Effect.repeat(Schedule.spaced(1_000)), Effect.forkScoped)
      const decodeSpec = Schema.decodeUnknownSync(SessionSpec)

      const host: ServerHost = {
        serverServices: {
          attachClient(presentation) {
            const provider = new RemoteServiceProvider([
              { service: SessionDirectory, mode: "singleton" },
              { service: SessionManagement, mode: "singleton" },
              { service: CloudSessions, mode: "singleton" }
            ])
            provider.provide(SessionDirectory, { state: directory })
            provider.provide(SessionManagement, {
              create: async (_options, context) => {
                const created = await run(sessions.create({}))
                await refresh(context)
                return summaryOf(created)
              },
              remove: async (sessionId, context) => {
                await presentation.prepareSessionRemoval(sessionId, context)
                await run(Effect.orDie(sessions.remove(sessionId)))
                await refresh(context)
              },
              attach: (sessionId, context) => presentation.attachSession(sessionId, context),
              detach: (context) => presentation.detachSession(context)
            })
            provider.provide(CloudSessions, {
              state: cloud,
              create: async (input, context) => {
                const created = await run(sessions.create({ title: input.title ?? undefined, spec: decodeSpec(input.spec) }))
                await refresh(context)
                return cloudOf(created)
              }
            })
            const endpoint = createRemoteServiceEndpoint(provider)
            let released = false
            const attachment: RoutedServerServiceAttachment = {
              invokeService: (call, publish, context) =>
                released ? Promise.reject(new Error("Server service attachment is released")) : endpoint.invoke(call, publish, context),
              release() {
                if (released) return
                released = true
                endpoint.dispose()
                provider.dispose()
              }
            }
            return attachment
          }
        },

        async resolveSession(sessionId) {
          const found = await run(store.get(sessionId as SessionId).pipe(Effect.orDie))
          if (Option.isNone(found)) throw new SessionNotFoundError(`Unknown session: ${sessionId}`)
          return { id: sessionId }
        },

        // ----- Session services: relayed to the runner hosting the session, which serves them.
        async openSession(metadata) {
          const session = Option.getOrThrow(await run(store.get(metadata.id as SessionId).pipe(Effect.orDie)))
          const { token, ended } = await run(runners.host(session))
          const call = (command: Parameters<typeof runners.call>[2]) => run(runners.call(session.id, token, command))
          const handle: RoutedSessionHandle = {
            // When the runner stops hosting the session, Pi's server clears its attachments; presentations reattach,
            // which opens the session again on a new runner.
            terminated: run(ended).then(() => new Error("The session's runner stopped")),
            attachClient() {
              const attachmentId = crypto.randomUUID()
              return {
                async invokeService(serviceCall, publish, context) {
                  publishers.set(attachmentId, publish)
                  const callId = crypto.randomUUID()
                  const cancel = () => void call({ _tag: "ServiceCancel", callId }).catch(() => {})
                  context.abortSignal?.addEventListener("abort", cancel, { once: true })
                  try {
                    const result = await call({ _tag: "ServiceCall", attachmentId, callId, call: serviceCall as never })
                    if (result._tag === "Ok") return result.value as never
                    throw isRemoteServiceErrorCode(result.tag) ? new RemoteServiceError(result.tag, result.message) : new Error(result.message)
                  } finally {
                    context.abortSignal?.removeEventListener("abort", cancel)
                  }
                },
                release() {
                  publishers.delete(attachmentId)
                  void call({ _tag: "ServiceRelease", attachmentId }).catch(() => {})
                }
              }
            },
            close: async () => {}
          }
          return handle
        }
      }

      // ----- Transport: Pi's protocol over a WebSocket, in binary frames.
      let accept: Parameters<ServerListener["start"]>[0] | undefined
      const server = new Server(host, {
        serverId,
        listeners: [{
          start: async (acceptor) => void (accept = acceptor),
          close: async () => {}
        }],
        onError: (error) => Effect.runFork(Effect.logWarning("pi server", error.message))
      })
      yield* Effect.promise(() => server.start())
      yield* Effect.addFinalizer(() => Effect.promise(() => server.close().catch(() => {})))

      const textEncoder = new TextEncoder()
      yield* router.add("GET", SERVICES_PATH, Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const bearer = request.headers["authorization"]?.replace(/^Bearer\s+/i, "")
        const authorized = yield* auth.check(bearer ?? url.searchParams.get("token") ?? undefined).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        )
        if (!authorized) return HttpServerResponse.text("Unauthorized", { status: 401 })
        const acceptor = accept
        if (acceptor === undefined) return HttpServerResponse.text("Starting", { status: 503 })

        const socket = yield* Effect.orDie(request.upgrade)
        const writer = yield* socket.writer
        const reader = yield* socket.reader
        let closed = false
        const closing = yield* Deferred.make<void>()
        const write = (chunk: Uint8Array) => Effect.runPromise(writer.write(chunk).pipe(Effect.ignore) as Effect.Effect<void>)
        const handler = acceptor({
          get closed() {
            return closed
          },
          send: write,
          close: async (finalChunk) => {
            if (finalChunk !== undefined) await write(finalChunk)
            closed = true
            Effect.runSync(Deferred.succeed(closing, undefined))
          }
        })
        yield* reader.pull.pipe(
          Effect.flatMap((chunks) =>
            Effect.sync(() => {
              for (const chunk of chunks) handler.onData(typeof chunk === "string" ? textEncoder.encode(chunk) : chunk)
            })
          ),
          Effect.forever,
          Effect.ignore,
          Effect.raceFirst(Deferred.await(closing))
        )
        if (!closed) {
          closed = true
          handler.onClose()
        }
        return HttpServerResponse.empty()
      }))

      return PiServer.of({
        serverId,
        publish: (attachmentId, subscriptionId, update) =>
          Effect.sync(() => void publishers.get(attachmentId)?.(subscriptionId, update as ServiceProviderUpdate, BACKGROUND_CONTEXT))
      })
    }))
}
