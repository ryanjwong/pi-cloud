import {
  type CommandResult,
  LeaseHeld,
  LeaseLost,
  type RunnerCommand,
  type RunnerMessage,
  RunnerUnavailable,
  type Session,
  SessionNotFound
} from "@pi-cloud/protocol"
import { type Cause, Context, Deferred, Effect, Layer, Option, Queue, Schedule, Stream } from "effect"
import { ControlPlaneConfig } from "./Config.ts"
import { LeaseManager } from "./ports/LeaseManager.ts"
import { RunnerDispatcher } from "./ports/RunnerDispatcher.ts"
import { SessionStore } from "./ports/SessionStore.ts"

/** A command without its id; `Runners.send` assigns one. */
export type CommandDraft = RunnerCommand extends infer C ? C extends RunnerCommand ? Omit<C, "commandId"> : never
  : never

/**
 * Tracks the runner attached to each session and routes commands to it. When a command arrives for a session with
 * no live runner, it asks the dispatcher to start one and waits for it to attach.
 */
export class Runners extends Context.Service<Runners, {
  attach(input: {
    readonly sessionId: string
    readonly runnerId: string
    readonly token?: string | undefined
  }): Stream.Stream<RunnerMessage, LeaseHeld | SessionNotFound>
  send(session: Session, command: CommandDraft): Effect.Effect<CommandResult, RunnerUnavailable>
  reply(sessionId: string, token: string, commandId: string, result: CommandResult): Effect.Effect<void, LeaseLost>
  /** Queue a command for the session's live runner without waiting for its reply. Does nothing without one. */
  notify(sessionId: string, command: CommandDraft): Effect.Effect<void>
  /** Ask a session's runner, if any, to stop. */
  shutdown(sessionId: string, reason: string): Effect.Effect<void>
  /** Whether a runner start has been requested and has not attached yet. */
  starting(sessionId: string): Effect.Effect<boolean>
}>()("@pi-cloud/control-plane/Runners") {
  static readonly layer: Layer.Layer<
    Runners,
    never,
    ControlPlaneConfig | LeaseManager | RunnerDispatcher | SessionStore
  > = Layer.effect(
    Runners,
    Effect.gen(function*() {
      const config = yield* ControlPlaneConfig
      const leases = yield* LeaseManager
      const dispatcher = yield* RunnerDispatcher
      const sessions = yield* SessionStore

      /** One per lease: commands queue here even while the runner's connection is being re-established. */
      interface Channel {
        readonly token: string
        /** Replaced on every re-attach, so only the newest connection reads commands. */
        queue: Queue.Queue<RunnerCommand, Cause.Done>
        readonly pending: Map<string, Deferred.Deferred<CommandResult>>
      }
      const channels = new Map<string, Channel>()
      /** Requests waiting for a woken runner to attach. */
      const waiters = new Map<string, Array<Deferred.Deferred<Channel>>>()

      const closeChannel = Effect.fnUntraced(function*(sessionId: string, channel: Channel, message: string) {
        if (channels.get(sessionId) === channel) channels.delete(sessionId)
        yield* Queue.end(channel.queue)
        for (const deferred of channel.pending.values()) {
          yield* Deferred.succeed(deferred, { _tag: "Err", tag: "LeaseLost", message })
        }
        channel.pending.clear()
      })

      /** The channel of the session's live lease, if its runner is still alive. */
      const liveChannel = Effect.fnUntraced(function*(sessionId: string) {
        const channel = channels.get(sessionId)
        if (channel === undefined) return undefined
        const lease = yield* leases.current(sessionId)
        if (Option.isSome(lease) && lease.value.token === channel.token) return channel
        yield* closeChannel(sessionId, channel, "The runner's lease expired")
        return undefined
      })

      const attach = (input: { readonly sessionId: string; readonly runnerId: string; readonly token?: string | undefined }) =>
        Stream.unwrap(Effect.gen(function*() {
          const session = yield* sessions.get(input.sessionId as Session["id"]).pipe(Effect.orDie)
          if (Option.isNone(session)) return yield* new SessionNotFound({ sessionId: input.sessionId })
          const lease = yield* leases.acquire(input.sessionId, input.runnerId, input.token)

          let channel = channels.get(input.sessionId)
          if (channel !== undefined && channel.token !== lease.token) {
            yield* closeChannel(input.sessionId, channel, "Another runner took over the session")
            channel = undefined
          }
          if (channel === undefined) {
            channel = { token: lease.token, queue: yield* Queue.unbounded<RunnerCommand, Cause.Done>(), pending: new Map() }
            channels.set(input.sessionId, channel)
          } else {
            // The same runner reconnected. End its previous stream and carry over commands it never took.
            const previous = channel.queue
            channel.queue = yield* Queue.unbounded<RunnerCommand, Cause.Done>()
            yield* Queue.offerAll(channel.queue, yield* Queue.clear(previous))
            yield* Queue.end(previous)
          }
          const waiting = waiters.get(input.sessionId) ?? []
          waiters.delete(input.sessionId)
          for (const deferred of waiting) yield* Deferred.succeed(deferred, channel)

          const granted: RunnerMessage = {
            _tag: "LeaseGranted",
            token: lease.token,
            epoch: lease.epoch,
            ttlMs: config.leaseTtlMs,
            session: session.value
          }
          return Stream.concat(
            Stream.make(granted),
            Stream.fromQueue(channel.queue).pipe(
              Stream.map((command): RunnerMessage => ({ _tag: "Command", command }))
            )
          )
        }))

      /** Wake a runner for the session unless one is already being started, then wait for it to attach. */
      const awaitRunner = Effect.fnUntraced(function*(sessionId: string) {
        const deferred = yield* Deferred.make<Channel>()
        const waiting = waiters.get(sessionId)
        if (waiting === undefined) {
          waiters.set(sessionId, [deferred])
          yield* dispatcher.wake({ sessionId, controlPlaneUrl: config.publicUrl }).pipe(
            Effect.tapError((error) =>
              Effect.gen(function*() {
                const failed = waiters.get(sessionId) ?? []
                waiters.delete(sessionId)
                for (const other of failed) if (other !== deferred) yield* Deferred.interrupt(other)
              })
            ),
            Effect.mapError((error) => new RunnerUnavailable({ sessionId, message: error.message }))
          )
        } else {
          waiting.push(deferred)
        }
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: config.attachTimeoutMs,
            orElse: () => {
              const left = (waiters.get(sessionId) ?? []).filter((other) => other !== deferred)
              if (left.length === 0) waiters.delete(sessionId)
              else waiters.set(sessionId, left)
              return Effect.fail(new RunnerUnavailable({ sessionId, message: "No runner attached in time" }))
            }
          }),
          Effect.onInterrupt(() => Effect.fail(new RunnerUnavailable({ sessionId, message: "Runner start failed" })))
        )
      })

      const send = Effect.fnUntraced(function*(session: Session, draft: CommandDraft) {
        const channel = (yield* liveChannel(session.id)) ?? (yield* awaitRunner(session.id))
        const commandId = crypto.randomUUID()
        const reply = yield* Deferred.make<CommandResult>()
        channel.pending.set(commandId, reply)
        yield* Queue.offer(channel.queue, { ...draft, commandId } as RunnerCommand)
        return yield* Deferred.await(reply).pipe(
          Effect.timeoutOrElse({
            duration: config.commandTimeoutMs,
            orElse: () =>
              Effect.fail(new RunnerUnavailable({ sessionId: session.id, message: "The runner did not answer in time" }))
          }),
          Effect.ensuring(Effect.sync(() => channel.pending.delete(commandId)))
        )
      })

      const reply = Effect.fnUntraced(function*(sessionId: string, token: string, commandId: string, result: CommandResult) {
        yield* leases.validate(sessionId, token)
        const channel = channels.get(sessionId)
        const deferred = channel?.token === token ? channel.pending.get(commandId) : undefined
        if (deferred !== undefined) yield* Deferred.succeed(deferred, result)
      })

      const notify = Effect.fnUntraced(function*(sessionId: string, draft: CommandDraft) {
        const channel = yield* liveChannel(sessionId)
        if (channel !== undefined) {
          yield* Queue.offer(channel.queue, { ...draft, commandId: crypto.randomUUID() } as RunnerCommand)
        }
      })

      // Crash recovery: a lease that expired without a release means its runner died, maybe mid-run. Wake the
      // session so a new runner reopens its state and Pi resumes whatever was unfinished.
      yield* Effect.gen(function*() {
        for (const sessionId of yield* leases.takeAbandoned()) {
          const exists = yield* sessions.get(sessionId as Session["id"]).pipe(Effect.orElseSucceed(() => Option.none()))
          if (Option.isNone(exists) || waiters.has(sessionId)) continue
          yield* Effect.logInfo("Waking session after its runner's lease expired", { sessionId })
          yield* awaitRunner(sessionId).pipe(
            Effect.catch((error) => Effect.logWarning("Recovery wake failed", { sessionId, error: error.message })),
            Effect.forkDetach
          )
        }
      }).pipe(Effect.repeat(Schedule.spaced(config.recoveryIntervalMs)), Effect.forkScoped)

      return Runners.of({
        attach,
        send,
        reply,
        notify,
        shutdown: (sessionId, reason) => notify(sessionId, { _tag: "Shutdown", reason }),
        starting: (sessionId) => Effect.sync(() => waiters.has(sessionId))
      })
    })
  )
}
