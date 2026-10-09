import {
  type ChannelMessage,
  type WorkspaceCall,
  type WorkspaceEvent,
  WorkspaceUnavailable
} from "@pi-cloud/protocol"
import { type Cause, Context, Deferred, Effect, Layer, Queue, type Scope, Stream } from "effect"

/** Answers a call's events as they come back from the serving client. */
export type WorkspaceReplies = (id: string, event: WorkspaceEvent) => Effect.Effect<void>

/**
 * Relays workspace calls from a session's runner to the client serving its workspace over the session channel.
 * The newest serving client wins. A call made while no client serves the workspace waits for one (up to
 * `waitMs`), so a session whose developer stepped away simply pauses at its next tool call.
 */
export class Workspaces extends Context.Service<Workspaces, {
  /** Serve `sessionId`'s workspace through `send` while the scope lasts. Returns where its replies go. */
  serve(
    sessionId: string,
    send: (message: ChannelMessage) => Effect.Effect<void>
  ): Effect.Effect<WorkspaceReplies, never, Scope.Scope>
  /** One call on the session's workspace: its events, ending when the call does. */
  call(sessionId: string, call: WorkspaceCall): Stream.Stream<WorkspaceEvent, WorkspaceUnavailable>
}>()("@pi-cloud/control-plane/Workspaces") {
  static readonly make = (options: { readonly waitMs?: number } = {}) =>
    Layer.sync(Workspaces, () => {
      const waitMs = options.waitMs ?? 10 * 60_000

      interface Server {
        readonly send: (message: ChannelMessage) => Effect.Effect<void>
        readonly pending: Map<string, Queue.Queue<WorkspaceEvent, WorkspaceUnavailable | Cause.Done>>
      }
      const servers = new Map<string, Server>()
      const waiters = new Map<string, Set<Deferred.Deferred<Server>>>()

      const unavailable = (sessionId: string, message: string) => new WorkspaceUnavailable({ sessionId, message })

      const awaitServer = (sessionId: string): Effect.Effect<Server, WorkspaceUnavailable> => {
        const current = servers.get(sessionId)
        if (current !== undefined) return Effect.succeed(current)
        return Effect.gen(function*() {
          const deferred = yield* Deferred.make<Server>()
          let set = waiters.get(sessionId)
          if (set === undefined) waiters.set(sessionId, set = new Set())
          set.add(deferred)
          return yield* Deferred.await(deferred).pipe(
            Effect.timeoutOrElse({
              duration: waitMs,
              orElse: () => Effect.fail(unavailable(sessionId, "No client is serving this session's workspace"))
            }),
            Effect.ensuring(Effect.sync(() => set.delete(deferred)))
          )
        })
      }

      return Workspaces.of({
        serve: (sessionId, send) =>
          Effect.gen(function*() {
            const server: Server = { send, pending: new Map() }
            servers.set(sessionId, server)
            for (const waiter of waiters.get(sessionId) ?? []) yield* Deferred.succeed(waiter, server)
            waiters.delete(sessionId)
            yield* Effect.addFinalizer(() =>
              Effect.gen(function*() {
                if (servers.get(sessionId) === server) servers.delete(sessionId)
                const pending = [...server.pending.values()]
                server.pending.clear()
                for (const queue of pending) {
                  yield* Queue.fail(queue, unavailable(sessionId, "The workspace disconnected during the call"))
                }
              })
            )
            return (id, event) => {
              const queue = server.pending.get(id)
              if (queue === undefined) return Effect.void
              if (event._tag !== "End") return Effect.asVoid(Queue.offer(queue, event))
              server.pending.delete(id)
              return Effect.asVoid(Queue.end(queue))
            }
          }),

        call: (sessionId, call) =>
          Stream.unwrap(Effect.gen(function*() {
            const server = yield* awaitServer(sessionId)
            const id = crypto.randomUUID()
            const queue = yield* Queue.unbounded<WorkspaceEvent, WorkspaceUnavailable | Cause.Done>()
            server.pending.set(id, queue)
            yield* server.send({ _tag: "WorkspaceCall", id, call })
            // A caller that stops listening before the call ended cancels it on the client.
            const release = Effect.suspend(() =>
              server.pending.delete(id) ? server.send({ _tag: "WorkspaceCancel", id }) : Effect.void
            )
            return Stream.fromQueue(queue).pipe(Stream.ensuring(release))
          }))
      })
    })

  static readonly layer = Workspaces.make()
}
