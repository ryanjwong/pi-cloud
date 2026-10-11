import type { ViewUpdate } from "@pi-cloud/protocol"
import { Context, Effect, Layer, PubSub, Stream } from "effect"

/** The session state's key; conversations are keyed by id. */
const keyOf = (update: ViewUpdate) => update.conversationId ?? "session"

/**
 * Fans view updates out to the presentations watching a session. Each state (the session state, each conversation's
 * view) keeps its newest snapshot and the operations after it, so a presentation that attaches late gets a
 * consistent state at once, then live updates.
 */
export class ViewHub extends Context.Service<ViewHub, {
  /** Returns `needsSnapshot` when a state's log is long enough that the runner should send a fresh snapshot. */
  publish(sessionId: string, updates: ReadonlyArray<ViewUpdate>): Effect.Effect<{ readonly needsSnapshot: boolean }>
  /** Buffered then live updates that `select` accepts. */
  subscribe(sessionId: string, select: (update: ViewUpdate) => boolean): Stream.Stream<ViewUpdate>
  /** Whether a conversation's view has been published, so watching it needs no new snapshot. */
  has(sessionId: string, conversationId: number): Effect.Effect<boolean>
  remove(sessionId: string): Effect.Effect<void>
}>()("@pi-cloud/core/ViewHub") {
  static readonly memory = (options: { readonly logLimit: number }): Layer.Layer<ViewHub> =>
    Layer.effect(
      ViewHub,
      Effect.gen(function*() {
        interface Topic {
          readonly pubsub: PubSub.PubSub<ViewUpdate>
          readonly logs: Map<number | "session", Array<ViewUpdate>>
        }
        const topics = new Map<string, Topic>()
        const topic = Effect.fnUntraced(function*(sessionId: string) {
          let found = topics.get(sessionId)
          if (found === undefined) {
            found = { pubsub: yield* PubSub.unbounded<ViewUpdate>(), logs: new Map() }
            topics.set(sessionId, found)
          }
          return found
        })
        return ViewHub.of({
          publish: Effect.fnUntraced(function*(sessionId, updates) {
            const { pubsub, logs } = yield* topic(sessionId)
            let needsSnapshot = false
            for (const update of updates) {
              const log = logs.get(keyOf(update))
              if (update.frame._tag === "Snapshot") logs.set(keyOf(update), [update])
              // Operations only extend a snapshot of the same runner.
              else if (log !== undefined && log[0]!.epoch === update.epoch) {
                log.push(update)
                if (log.length > options.logLimit) needsSnapshot = true
              } else needsSnapshot = true
            }
            yield* PubSub.publishAll(pubsub, updates)
            return { needsSnapshot }
          }),
          subscribe: (sessionId, accept) =>
            Stream.unwrap(Effect.gen(function*() {
              const { pubsub, logs } = yield* topic(sessionId)
              // Subscribe before reading the logs so nothing published in between is lost.
              const subscription = yield* PubSub.subscribe(pubsub)
              const buffered = [...logs.values()].flat().filter(accept).sort((a, b) => a.epoch - b.epoch || a.seq - b.seq)
              const last = new Map<number | "session", ViewUpdate>()
              for (const update of buffered) last.set(keyOf(update), update)
              // Skip what the buffer already delivered; drop operations whose snapshot this subscriber never saw.
              const fresh = (update: ViewUpdate) => {
                const previous = last.get(keyOf(update))
                if (previous !== undefined && update.epoch === previous.epoch && update.seq <= previous.seq) return false
                if (update.frame._tag === "Ops" && (previous === undefined || previous.epoch !== update.epoch)) return false
                last.set(keyOf(update), update)
                return true
              }
              return Stream.concat(
                Stream.fromIterable(buffered),
                Stream.fromSubscription(subscription).pipe(Stream.filter((update) => accept(update) && fresh(update)))
              )
            })),
          has: (sessionId, conversationId) => Effect.sync(() => topics.get(sessionId)?.logs.has(conversationId) ?? false),
          remove: (sessionId) =>
            Effect.suspend(() => {
              const found = topics.get(sessionId)
              topics.delete(sessionId)
              return found === undefined ? Effect.void : PubSub.shutdown(found.pubsub)
            })
        })
      })
    )
}
