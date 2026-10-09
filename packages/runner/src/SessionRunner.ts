import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
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
import type { CommandResult, EventBatch, RunnerCommand, Session, WorkspaceCall, WorkspaceEvent } from "@pi-cloud/protocol"
import { Cause, Deferred, Effect, Exit, Fiber, Schedule, Stream } from "effect"
import type { ControlPlaneClient } from "./ControlPlaneClient.ts"
import { noSecrets, type PluginParts, type RunnerPlugin, runSetup, type RunningSession, type SecretResolver } from "./Plugin.ts"
import { LeaseLostError, RemoteStorage } from "./RemoteStorage.ts"
import { VIEW_STREAM, ViewPublisher } from "./View.ts"

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
  /** The view presentations such as Pi's TUI render. */
  view: ViewPublisher | undefined
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

  const publish = (current: Hosted, conversationId: number, events: ReadonlyArray<unknown>, stream?: string) => {
    const batch: EventBatch = {
      epoch: current.epoch,
      seq: ++current.seq,
      conversationId,
      events: toJson(events) as any,
      ...(stream === undefined ? {} : { stream })
    }
    current.publishing = current.publishing.then(() =>
      run(client.Publish({ sessionId, token: current.token, batches: [batch] })).catch((error) => {
        if ((error as { _tag?: string })._tag === "LeaseLost") stopNow("lease-lost")
      })
    )
    return current.publishing
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
    const workspace = (
      call: WorkspaceCall,
      onEvent: (event: WorkspaceEvent) => void,
      signal: AbortSignal | undefined
    ) =>
      Effect.runPromise(
        client.Workspace({ sessionId, token, call }).pipe(Stream.runForEach((event) => Effect.sync(() => onEvent(event)))),
        { signal }
      )
    const parts: Array<PluginParts> = []
    for (const plugin of options.plugins) {
      parts.push(await runSetup(plugin, { session, config: session.spec.plugins?.[plugin.name], secrets, workspace }))
    }
    const credentials = options.modelCredentials
    const models = createModels(credentials === undefined ? undefined : {
      authContext: { env: async (name) => credentials(name), fileExists: async () => false }
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
        hosted?.view?.notice("warning", error instanceof Error ? error.message : String(error))
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
      view: undefined,
      seq: 0,
      publishing: Promise.resolve()
    }
    for (const part of parts) await part.ready?.(current, context)
    await startWatch(current)
    const view = new ViewPublisher(harness, models, context, (id, events) => void publish(current, id, events, VIEW_STREAM))
    current.view = view
    await view.start(root.id)
    return current
  }

  const close = async (current: Hosted) => {
    current.view?.close()
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

  /** Commands of the view protocol, for presentations such as Pi's TUI. */
  const viewCommand = async (
    current: Hosted,
    name: string,
    payload: Record<string, unknown> | null
  ): Promise<CommandResult | undefined> => {
    const view = current.view
    if (view === undefined || !name.startsWith("view.")) return undefined
    const id = typeof payload?.conversationId === "number" ? payload.conversationId : current.root.id
    switch (name) {
      case "view.watch":
        await view.watch(id)
        return { _tag: "Ok" }
      case "view.cycleThinking": {
        await view.watch(id)
        const thinkingLevel = view.nextThinkingLevel(view.viewOf(id)!)
        await (await conversation(current, id)).configure({ thinkingLevel }, current.context)
        return { _tag: "Ok", value: { thinkingLevel } }
      }
      case "view.setModel": {
        await view.watch(id)
        const model = { provider: String(payload?.provider), modelId: String(payload?.modelId) }
        const thinkingLevel = view.thinkingFor(view.viewOf(id)!, model)
        await (await conversation(current, id)).configure({ model, thinkingLevel }, current.context)
        return { _tag: "Ok", value: { model, thinkingLevel } }
      }
      default:
        return { _tag: "Err", tag: "UnknownCommand", message: `Unknown view command ${name}` }
    }
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
          current.view?.watchAnswer(submission)
          return { _tag: "Ok", value: { submissionId: submission.id, conversationId: target.id } }
        }
        case "Abort": {
          await (await conversation(current, command.conversationId)).abort(current.context)
          return { _tag: "Ok" }
        }
        case "Configure": {
          const target = await conversation(current, command.conversationId)
          await target.configure({
            ...(command.model === undefined ? {} : { model: command.model }),
            ...(command.thinkingLevel === undefined ? {} : { thinkingLevel: command.thinkingLevel as never }),
            ...(command.instructions === undefined ? {} : { instructions: command.instructions })
          }, current.context)
          return { _tag: "Ok" }
        }
        case "Compact": {
          const target = await conversation(current, command.conversationId)
          const taskId = await target.compact(command.instructions, current.context)
          current.view?.watchCompaction(taskId)
          return { _tag: "Ok", value: { taskId } }
        }
        case "Reset": {
          await (await conversation(current, command.conversationId)).reset(command.handoff, current.context)
          return { _tag: "Ok" }
        }
        case "Resnapshot": {
          await startWatch(current)
          current.view?.resnapshot()
          return { _tag: "Ok" }
        }
        case "Shutdown": {
          stopNow("shutdown")
          return { _tag: "Ok" }
        }
        case "Custom": {
          const builtIn = await viewCommand(current, command.name, command.payload as Record<string, unknown> | null)
          if (builtIn !== undefined) return builtIn
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
    const busy = inspection.submissions.length > 0 || inspection.tasks.some((task) => task.state.kind !== "blocked")
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
