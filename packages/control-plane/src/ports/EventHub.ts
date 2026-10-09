import type { EventBatch } from "@pi-cloud/protocol"
import { Context, Effect, Layer, PubSub, Stream } from "effect"

/** Where a client last left a session's event stream. */
export interface StreamPosition {
  readonly epoch: number
  readonly seq: number
}

export const parsePosition = (value: string | undefined): StreamPosition | undefined => {
  const match = value === undefined ? null : /^(\d+):(\d+)$/.exec(value)
  return match === null ? undefined : { epoch: Number(match[1]), seq: Number(match[2]) }
}

const isSnapshot = (batch: EventBatch) => (batch.events[0] as { type?: unknown } | undefined)?.type === "snapshot"

/**
 * Fans live agent events out to every client watching a session. Runners publish Pi's per-commit event batches;
 * the hub keeps each conversation's batches since its newest snapshot, so a client that joins late gets the
 * snapshot and everything after it, then live batches.
 */
export class EventHub extends Context.Service<EventHub, {
  /** Returns `needsSnapshot` when the buffered log is long enough that the runner should send a fresh snapshot. */
  publish(sessionId: string, batches: ReadonlyArray<EventBatch>): Effect.Effect<{ readonly needsSnapshot: boolean }>
  /** Buffered batches (resuming after `after` when possible), then live ones. */
  subscribe(sessionId: string, after: StreamPosition | undefined): Stream.Stream<EventBatch>
  remove(sessionId: string): Effect.Effect<void>
}>()("@pi-cloud/control-plane/EventHub") {
  static readonly memory = (options: { readonly logLimit: number }): Layer.Layer<EventHub> =>
    Layer.effect(
      EventHub,
      Effect.gen(function*() {
        interface Topic {
          readonly pubsub: PubSub.PubSub<EventBatch>
          /** Per conversation: the newest snapshot batch and every batch after it. */
          readonly logs: Map<number, Array<EventBatch>>
        }
        const topics = new Map<string, Topic>()

        const topic = Effect.fnUntraced(function*(sessionId: string) {
          let found = topics.get(sessionId)
          if (found === undefined) {
            found = { pubsub: yield* PubSub.unbounded<EventBatch>(), logs: new Map() }
            topics.set(sessionId, found)
          }
          return found
        })

        const replay = (logs: Map<number, Array<EventBatch>>, after: StreamPosition | undefined) => {
          const out: Array<EventBatch> = []
          for (const log of logs.values()) {
            const first = log[0]
            const resumable = after !== undefined && first !== undefined && first.epoch === after.epoch &&
              first.seq <= after.seq + 1
            out.push(...(resumable ? log.filter((batch) => batch.seq > after.seq) : log))
          }
          return out.sort((a, b) => a.epoch - b.epoch || a.seq - b.seq)
        }

        return EventHub.of({
          publish: Effect.fnUntraced(function*(sessionId, batches) {
            const { pubsub, logs } = yield* topic(sessionId)
            let needsSnapshot = false
            for (const batch of batches) {
              const log = logs.get(batch.conversationId)
              const stale = log?.[0] !== undefined && log[0].epoch !== batch.epoch
              if (isSnapshot(batch) || log === undefined || stale) {
                logs.set(batch.conversationId, [batch])
              } else {
                log.push(batch)
                if (log.length > options.logLimit) needsSnapshot = true
              }
            }
            yield* PubSub.publishAll(pubsub, batches)
            return { needsSnapshot }
          }),
          subscribe: (sessionId, after) =>
            Stream.unwrap(Effect.gen(function*() {
              const { pubsub, logs } = yield* topic(sessionId)
              // Subscribe before reading the log so nothing published in between is lost.
              const subscription = yield* PubSub.subscribe(pubsub)
              const buffered = replay(logs, after)
              const seen = new Map<number, StreamPosition>()
              for (const batch of buffered) seen.set(batch.conversationId, batch)
              const fresh = (batch: EventBatch) => {
                const last = seen.get(batch.conversationId)
                if (last !== undefined && batch.epoch === last.epoch && batch.seq <= last.seq) return false
                seen.set(batch.conversationId, batch)
                return true
              }
              return Stream.concat(
                Stream.fromIterable(buffered),
                Stream.fromSubscription(subscription).pipe(Stream.filter(fresh))
              )
            })),
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
