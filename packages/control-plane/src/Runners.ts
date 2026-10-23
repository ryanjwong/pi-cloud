import type { Link } from "@earendil-works/chord"
import {
  type CommandResult,
  FrameLink,
  LeaseHeld,
  LeaseLost,
  type RunnerCommand,
  type RunnerMessage,
  RunnerUnavailable,
  secretsEqual,
  type Session,
  SessionNotFound,
  Unauthorized
} from "@pi-cloud/protocol"
import { type Cause, Context, Deferred, Effect, Layer, Option, Queue, Schedule, Stream } from "effect"
import { ControlPlaneConfig, LeaseManager, RunnerDispatcher, SessionStore } from "@pi-cloud/core"
import { randomBytes } from "node:crypto"

type Envelope = Exclude<RunnerMessage, { readonly _tag: "LeaseGranted" }>

export class Runners extends Context.Service<Runners, {
  attach(input: {
    readonly sessionId: string
    readonly runnerId: string
    readonly grant: string
    readonly token?: string | undefined
  }): Stream.Stream<RunnerMessage, LeaseHeld | SessionNotFound | Unauthorized>
  send(session: Session, command: RunnerCommand): Effect.Effect<CommandResult, RunnerUnavailable>
  reply(sessionId: string, token: string, commandId: string, result: CommandResult): Effect.Effect<void, LeaseLost>
  notify(sessionId: string, command: RunnerCommand): Effect.Effect<void>
  shutdown(sessionId: string, reason: string): Effect.Effect<void>
  starting(sessionId: string): Effect.Effect<boolean>
  link(session: Session): Effect.Effect<Link, RunnerUnavailable>
  frames(sessionId: string, token: string, link: number, frames: ReadonlyArray<unknown>): Effect.Effect<void, LeaseLost>
  released(sessionId: string, token: string): Effect.Effect<void>
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

      interface Channel {
        readonly token: string
        queue: Queue.Queue<Envelope, Cause.Done>
        readonly pending: Map<string, Deferred.Deferred<CommandResult>>
        readonly closed: Deferred.Deferred<void>
        link: { readonly id: number; readonly link: FrameLink } | undefined
        links: number
      }
      const channels = new Map<string, Channel>()
      const waiters = new Map<string, Array<Deferred.Deferred<Channel>>>()
      const grants = new Map<string, string>()

      const verifyGrant = (sessionId: string, grant: string) =>
        secretsEqual(grant, grants.get(sessionId) ?? "") && grant !== ""
          ? Effect.void
          : Effect.fail(new Unauthorized({ message: "This runner was not woken for the session" }))

      const closeChannel = Effect.fnUntraced(function*(sessionId: string, channel: Channel, message: string) {
        if (channels.get(sessionId) === channel) channels.delete(sessionId)
        yield* Deferred.succeed(channel.closed, undefined)
        channel.link?.link.end(message)
        yield* Queue.end(channel.queue)
        for (const deferred of channel.pending.values()) {
          yield* Deferred.succeed(deferred, { _tag: "Err", tag: "LeaseLost", message })
        }
        channel.pending.clear()
      })

      const liveChannel = Effect.fnUntraced(function*(sessionId: string) {
        const channel = channels.get(sessionId)
        if (channel === undefined) return undefined
        const lease = yield* leases.current(sessionId)
        if (Option.isSome(lease) && lease.value.token === channel.token) return channel
        yield* closeChannel(sessionId, channel, "The runner's lease expired")
        return undefined
      })

      const attach = (input: { readonly sessionId: string; readonly runnerId: string; readonly grant: string; readonly token?: string | undefined }) =>
        Stream.unwrap(Effect.gen(function*() {
          yield* verifyGrant(input.sessionId, input.grant)
          const session = yield* sessions.get(input.sessionId as Session["id"]).pipe(Effect.orDie)
          if (Option.isNone(session)) return yield* new SessionNotFound({ sessionId: input.sessionId })
          const lease = yield* leases.acquire(input.sessionId, input.runnerId, input.token)

          let channel = channels.get(input.sessionId)
          if (channel !== undefined && channel.token !== lease.token) {
            yield* closeChannel(input.sessionId, channel, "Another runner took over the session")
            channel = undefined
          }
          if (channel === undefined) {
            channel = {
              token: lease.token,
              queue: yield* Queue.unbounded<Envelope, Cause.Done>(),
              pending: new Map(),
              closed: yield* Deferred.make<void>(),
              link: undefined,
              links: 0
            }
            channels.set(input.sessionId, channel)
          } else {
            const previous = channel.queue
            channel.queue = yield* Queue.unbounded<Envelope, Cause.Done>()
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
            Stream.fromQueue(channel.queue)
          )
        }))

      const awaitRunner = Effect.fnUntraced(function*(sessionId: string) {
        const deferred = yield* Deferred.make<Channel>()
        const waiting = waiters.get(sessionId)
        if (waiting === undefined) {
          waiters.set(sessionId, [deferred])
          const grant = randomBytes(32).toString("base64url")
          grants.set(sessionId, grant)
          yield* dispatcher.wake({ sessionId, controlPlaneUrl: config.publicUrl, grant }).pipe(
            Effect.tapError(() =>
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

      const send = Effect.fnUntraced(function*(session: Session, command: RunnerCommand) {
        const channel = (yield* liveChannel(session.id)) ?? (yield* awaitRunner(session.id))
        const commandId = crypto.randomUUID()
        const reply = yield* Deferred.make<CommandResult>()
        channel.pending.set(commandId, reply)
        yield* Queue.offer(channel.queue, { _tag: "Command", commandId, command })
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

      const notify = Effect.fnUntraced(function*(sessionId: string, command: RunnerCommand) {
        const channel = yield* liveChannel(sessionId)
        if (channel !== undefined) yield* Queue.offer(channel.queue, { _tag: "Command", commandId: crypto.randomUUID(), command })
      })

      const recovering = new Set<string>()
      yield* Effect.gen(function*() {
        for (const sessionId of yield* leases.takeAbandoned()) {
          const stale = channels.get(sessionId)
          if (stale !== undefined) yield* closeChannel(sessionId, stale, "The runner's lease expired")
          recovering.add(sessionId)
        }
        for (const sessionId of recovering) {
          if (Option.isSome(yield* leases.current(sessionId))) {
            recovering.delete(sessionId)
            continue
          }
          const exists = yield* sessions.get(sessionId as Session["id"]).pipe(Effect.orElseSucceed(() => Option.none()))
          if (Option.isNone(exists)) {
            recovering.delete(sessionId)
            continue
          }
          if (waiters.has(sessionId)) continue
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
        link: Effect.fnUntraced(function*(session) {
          const channel = (yield* liveChannel(session.id)) ?? (yield* awaitRunner(session.id))
          if (channel.link !== undefined && !channel.link.link.closed) return channel.link.link
          const id = ++channel.links
          const link = new FrameLink((frames) =>
            Effect.runSync(Queue.offer(channel.queue, { _tag: "Frames", link: id, frames: frames as never }))
          )
          channel.link = { id, link }
          return link
        }),
        frames: Effect.fnUntraced(function*(sessionId, token, link, frames) {
          yield* leases.validate(sessionId, token)
          const channel = channels.get(sessionId)
          if (channel?.token === token && channel.link?.id === link) channel.link.link.deliver(frames)
        }),
        released: Effect.fnUntraced(function*(sessionId, token) {
          const channel = channels.get(sessionId)
          if (channel !== undefined && channel.token === token) yield* closeChannel(sessionId, channel, "The runner released the session")
        }),
        starting: (sessionId) => Effect.sync(() => waiters.has(sessionId))
      })
    })
  )
}
