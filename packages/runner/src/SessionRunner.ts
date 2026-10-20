import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context"
import { clampThinkingLevel } from "@earendil-works/pi-ai"
import { createModels, type Models } from "@earendil-works/pi-ai/models"
import {
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  ConversationBusy,
  createRegistry,
  Harness,
  type HarnessSettings,
  watchEvents
} from "@earendil-works/pi-durable"
import type { CommandResult, EventBatch, RunnerCommand, Session } from "@pi-cloud/protocol"
import { RemoteServiceError } from "@earendil-works/chord"
import { Cause, Deferred, Effect, Exit, Fiber, Schedule, Stream } from "effect"
import type { ControlPlaneClient } from "./ControlPlaneClient.ts"
import { noSecrets, type PluginParts, type RunnerPlugin, runSetup, type RunningSession, type SecretResolver } from "./Plugin.ts"
import { LeaseLostError, RemoteStorage } from "./RemoteStorage.ts"
import { RemoteCredentialStore } from "./RemoteCredentials.ts"
import { openSessionServices, type SessionServices } from "./Services.ts"

export interface SessionRunnerOptions {
  readonly plugins: ReadonlyArray<RunnerPlugin>
  /** Resolves secret names that sandbox templates request. Defaults to none. */
  readonly secrets?: SecretResolver
  /** Base harness settings; plugin settings are merged over them. */
  readonly settings?: HarnessSettings
  /** Release the lease after the session has had no work for this long. Default 30 s. */
  readonly idleMs?: number
  /** Identifies this runner in leases and logs. */
  readonly runnerId?: string
  /**
   * Where model providers look up their credentials (`ANTHROPIC_API_KEY`, ...). When set, pi-ai reads nothing
   * from the process environment or disk; when omitted it falls back to its ambient lookup.
   */
  readonly modelCredentials?: (name: string) => string | undefined
}

/** Why a runner stopped hosting a session. */
export type StopReason = "idle" | "shutdown" | "lease-lost" | "failed"

const toJson = <T>(value: T): T => JSON.parse(JSON.stringify(value))

const errorResult = (error: unknown): CommandResult => ({
  _tag: "Err",
  tag: error instanceof ConversationBusy ? "ConversationBusy" : error instanceof Error ? error.name : "Error",
  message: error instanceof Error ? error.message : String(error)
})

/** Everything that belongs to one lease. */
interface Hosted extends RunningSession {
  readonly storage: RemoteStorage
  readonly token: string
  readonly epoch: number
  readonly parts: ReadonlyArray<PluginParts>
  readonly context: Context
  readonly cancel: () => void
  watch: AgentEventStream | undefined
  /** The session's Chord services, for attached presentations; see `Services.ts`. */
  services: SessionServices | undefined
  readonly models: Models
  seq: number
  /** Publishes run one after another so batches arrive in order. */
  publishing: Promise<void>
}

/**
 * Host one session until it goes idle, is shut down, or the lease is lost. The runner holds the session's lease,
 * runs Pi Durable against the control plane's storage, executes commands, and publishes Pi's events.
 */
export const hostSession = Effect.fnUntraced(function*(
  client: ControlPlaneClient,
  sessionId: string,
  options: SessionRunnerOptions
) {
  const runnerId = options.runnerId ?? `runner_${crypto.randomUUID()}`
  const idleMs = options.idleMs ?? 30_000
  const secrets = options.secrets ?? noSecrets
  const stopped = yield* Deferred.make<StopReason>()
  const stop = (reason: StopReason) => Deferred.succeed(stopped, reason).pipe(Effect.asVoid)
  const stopNow = (reason: StopReason) => void Effect.runFork(stop(reason))

  let hosted: Hosted | undefined
  let ttlMs = 15_000
  let lastActive = Date.now()

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

  const publish = (current: Hosted, conversationId: number, events: ReadonlyArray<unknown>) => {
    const batch: EventBatch = { epoch: current.epoch, seq: ++current.seq, conversationId, events: toJson(events) as any }
    current.publishing = current.publishing.then(() =>
      run(client.Publish({ sessionId, token: current.token, batches: [batch] })).catch((error) => {
        if ((error as { _tag?: string })._tag === "LeaseLost") stopNow("lease-lost")
      })
    )
    return current.publishing
  }

  /** Relay a subscription update of an attached presentation to the control plane, in order. */
  const publishService = (current: Hosted, attachmentId: string, subscriptionId: string, update: unknown) => {
    current.publishing = current.publishing.then(() =>
      run(client.ServiceUpdate({ sessionId, token: current.token, attachmentId, subscriptionId, update: toJson(update) as never }))
        .catch((error) => {
          if ((error as { _tag?: string })._tag === "LeaseLost") stopNow("lease-lost")
        })
    )
  }

  /** (Re)start the root conversation's event stream; it begins with a snapshot. */
  const startWatch = async (current: Hosted) => {
    const previous = current.watch
    current.watch = undefined
    await previous?.stop()
    const watch = await watchEvents(current.harness, current.root.id, current.context)
    current.watch = watch
    await publish(current, current.root.id, [watch.snapshot])
    watch.start(async (events) => {
      lastActive = Date.now()
      await publish(current, current.root.id, events)
    })
  }

  const open = async (session: Session, token: string, epoch: number): Promise<Hosted> => {
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT)
    const storage = new RemoteStorage(async (method, args) => {
      try {
        const { value } = await run(client.Storage({ sessionId, token, method, args: args as any }))
        // A missing record may arrive as `null`; Storage reports misses as `undefined`.
        return value ?? undefined
      } catch (error) {
        if ((error as { _tag?: string })._tag === "LeaseLost") {
          stopNow("lease-lost")
          throw new LeaseLostError(sessionId)
        }
        throw error
      }
    })
    const parts: Array<PluginParts> = []
    for (const plugin of options.plugins) {
      parts.push(await runSetup(plugin, { session, config: session.spec.plugins?.[plugin.name], secrets }))
    }
    // Stored credentials (API keys, subscription logins) come from the control plane; environment keys from the
    // runner's configuration. pi-ai refreshes OAuth tokens through the store, for every runner at once.
    const credentials = options.modelCredentials
    const store = new RemoteCredentialStore({
      get: (providerId) => run(client.CredentialGet({ sessionId, token, providerId })) as never,
      list: () => run(client.CredentialList({ sessionId, token })) as never,
      put: (providerId, version, credential) =>
        run(client.CredentialPut({ sessionId, token, providerId, version, credential: credential as never }))
    })
    const models = createModels({
      credentials: store,
      ...(credentials === undefined
        ? {}
        : { authContext: { env: async (name: string) => credentials(name), fileExists: async () => false } })
    })
    const registry = createRegistry()
    let settings: HarnessSettings = { ...options.settings }
    for (const part of parts) {
      part.models?.(models)
      for (const extension of part.extensions ?? []) registry.install(extension)
      if (part.settings !== undefined) settings = { ...settings, ...part.settings }
    }
    const harness = await Harness.open(storage, {
      models,
      registry,
      settings,
      env: async (target, envContext) => {
        for (const part of parts) {
          const env = await part.env?.(target, envContext)
          if (env !== undefined) return env
        }
        return undefined
      },
      onReport: (error) => {
        console.warn(`[pi-cloud runner ${runnerId}] ${sessionId}:`, error)
        hosted?.services?.notice("warning", error instanceof Error ? error.message : String(error))
      }
    }, context)
    const { model, thinkingLevel, instructions } = session.spec
    const root = await harness.root(context, {
      agent: {
        ...(model === undefined ? {} : { model }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as never }),
        ...(instructions === undefined ? {} : { instructions })
      }
    })
    harness.resume()
    const current: Hosted = {
      storage,
      session,
      harness,
      root,
      token,
      epoch,
      parts,
      context,
      cancel,
      watch: undefined,
      services: undefined,
      models,
      seq: 0,
      publishing: Promise.resolve()
    }
    for (const part of parts) await part.ready?.(current, context)
    await startWatch(current)
    current.services = await openSessionServices({
      harness,
      root,
      models,
      facets: parts.flatMap((part) => part.facets ?? []),
      context
    })
    return current
  }

  const close = async (current: Hosted) => {
    await current.services?.dispose().catch(() => {})
    await current.watch?.stop().catch(() => {})
    await Promise.race([
      current.harness.close(current.context).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ])
    current.cancel()
    for (const part of current.parts) await Promise.resolve(part.dispose?.()).catch(() => {})
  }

  const conversation = async (current: Hosted, id: number | undefined): Promise<Conversation> => {
    if (id === undefined) return current.root
    const found = await current.harness.conversation(id as ConversationId, current.context)
    if (found === undefined) throw new Error(`Conversation ${id} not found`)
    return found
  }

  const execute = async (current: Hosted, command: RunnerCommand): Promise<CommandResult> => {
    lastActive = Date.now()
    try {
      switch (command._tag) {
        case "Prompt": {
          const target = await conversation(current, command.conversationId)
          const submission = await target.submit({
            type: "input",
            content: command.content as never,
            ...(command.requestId === undefined ? {} : { requestId: command.requestId }),
            ...(command.whenBusy === undefined ? {} : { whenBusy: command.whenBusy })
          }, current.context)
          current.services?.watchAnswer(submission)
          return { _tag: "Ok", value: { submissionId: submission.id, conversationId: target.id } }
        }
        case "Abort": {
          await (await conversation(current, command.conversationId)).abort(current.context)
          return { _tag: "Ok" }
        }
        case "Configure": {
          const target = await conversation(current, command.conversationId)
          // A new model keeps the current thinking level, clamped to what it supports.
          let thinkingLevel = command.thinkingLevel
          if (command.model != null && thinkingLevel === undefined) {
            const model = current.models.getModel(command.model.provider, command.model.modelId)
            if (model === undefined) throw new Error(`Unknown model: ${command.model.provider}/${command.model.modelId}`)
            const view = await target.viewState(current.context)
            const level = (view.value.docs["pi.agent"] as { thinkingLevel?: string } | undefined)?.thinkingLevel ?? "off"
            view.dispose()
            thinkingLevel = clampThinkingLevel(model, level as never)
          }
          await target.configure({
            ...(command.model === undefined ? {} : { model: command.model }),
            ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as never }),
            ...(command.instructions === undefined ? {} : { instructions: command.instructions })
          }, current.context)
          return { _tag: "Ok" }
        }
        case "Compact": {
          const target = await conversation(current, command.conversationId)
          const taskId = await target.compact(command.instructions, current.context)
          current.services?.watchCompaction(taskId)
          return { _tag: "Ok", value: { taskId } }
        }
        case "Reset": {
          await (await conversation(current, command.conversationId)).reset(command.handoff, current.context)
          return { _tag: "Ok" }
        }
        case "ServiceCall": {
          const services = current.services
          if (services === undefined) return { _tag: "Err", tag: "service_not_found", message: "The session is not open" }
          try {
            const value = await services.invoke(command.attachmentId, command.callId, command.call, (subscriptionId, update) =>
              publishService(current, command.attachmentId, subscriptionId, update))
            return value === undefined ? { _tag: "Ok" } : { _tag: "Ok", value: toJson(value) as never }
          } catch (error) {
            // Chord errors keep their code; anything else is an internal error, as with Pi's own server.
            return error instanceof RemoteServiceError
              ? { _tag: "Err", tag: error.code, message: error.message }
              : { _tag: "Err", tag: "internal_error", message: error instanceof Error ? error.message : String(error) }
          }
        }
        case "ServiceCancel": {
          current.services?.cancel(command.callId)
          return { _tag: "Ok" }
        }
        case "ServiceRelease": {
          current.services?.release(command.attachmentId)
          return { _tag: "Ok" }
        }
        case "Resnapshot": {
          await startWatch(current)
          return { _tag: "Ok" }
        }
        case "Shutdown": {
          stopNow("shutdown")
          return { _tag: "Ok" }
        }
        case "Custom": {
          for (const part of current.parts) {
            const handler = part.commands?.[command.name]
            if (handler !== undefined) {
              return { _tag: "Ok", value: toJson(await handler(command.payload, current, current.context)) as never }
            }
          }
          return { _tag: "Err", tag: "UnknownCommand", message: `No plugin handles command ${command.name}` }
        }
      }
    } catch (error) {
      return errorResult(error)
    }
  }

  const handleCommand = (commandId: string, command: RunnerCommand) => {
    const current = hosted
    if (current === undefined) return
    void execute(current, command).then((result) =>
      run(client.Reply({ sessionId, token: current.token, commandId, result })).catch(() => {})
    )
  }

  /** Attach, and re-attach with the same token whenever the connection drops while the lease is still ours. */
  const attachLoop = Effect.gen(function*() {
    while (true) {
      const exit = yield* client.Attach({ sessionId, runnerId, token: hosted?.token }).pipe(
        Stream.runForEach((message) =>
          Effect.promise(async () => {
            if (message._tag === "Command") return handleCommand(message.commandId, message.command)
            ttlMs = message.ttlMs
            if (hosted?.token === message.token) return
            // A new lease: whatever we held before may be stale, so start over from storage.
            if (hosted !== undefined) await close(hosted)
            hosted = undefined
            hosted = await open(message.session, message.token, message.epoch)
            lastActive = Date.now()
          })
        ),
        Effect.exit
      )
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as { _tag?: string }
        if (error._tag === "LeaseHeld" || error._tag === "SessionNotFound") {
          return yield* stop(hosted === undefined ? "failed" : "lease-lost")
        }
        if (hosted === undefined) {
          yield* Effect.logWarning("Runner failed to start session", { sessionId, cause: Cause.pretty(exit.cause) })
          return yield* stop("failed")
        }
      }
      yield* Effect.sleep(1_000)
    }
  })

  const heartbeat = Effect.gen(function*() {
    while (true) {
      yield* Effect.sleep(Math.max(500, Math.floor(ttlMs / 3)))
      const current = hosted
      if (current === undefined) continue
      yield* client.Renew({ sessionId, token: current.token }).pipe(
        Effect.catchTag("LeaseLost", () => stop("lease-lost")),
        Effect.ignore
      )
    }
  })

  const idleWatch = Effect.gen(function*() {
    const current = hosted
    if (current === undefined) return
    const inspection = yield* Effect.promise(() => current.harness.inspect(current.context))
    // Attached presentations keep the session hosted, as Pi's server keeps a worker while presentations demand it.
    const busy = inspection.submissions.length > 0 || inspection.tasks.some((task) => task.state.kind !== "blocked") ||
      (current.services?.attachments ?? 0) > 0
    if (busy) lastActive = Date.now()
    else if (Date.now() - lastActive > idleMs) yield* stop("idle")
  }).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.repeat(Schedule.spaced(Math.max(100, Math.min(5_000, Math.floor(idleMs / 2)))))
  )

  /** Interrupted (e.g. the host is killed): stop writing at once, as a crash would, and keep the lease. */
  const abandon = Effect.promise(async () => {
    const current = hosted
    hosted = undefined
    if (current === undefined) return
    current.storage.abandon()
    current.cancel()
    void current.watch?.stop().catch(() => {})
  })

  const fibers = [
    yield* Effect.forkChild(attachLoop),
    yield* Effect.forkChild(heartbeat),
    yield* Effect.forkChild(idleWatch)
  ]
  const reason = yield* Deferred.await(stopped).pipe(Effect.onInterrupt(() => abandon))
  yield* Fiber.interruptAll(fibers)
  const current = hosted
  hosted = undefined
  if (current !== undefined) {
    yield* Effect.promise(() => close(current))
    if (reason !== "lease-lost") {
      yield* client.Release({ sessionId, token: current.token }).pipe(Effect.ignore)
    }
  }
  yield* Effect.logDebug("Runner stopped hosting session", { sessionId, reason })
  return reason
})
