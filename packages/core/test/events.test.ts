import type { EventBatch } from "@pi-cloud/protocol"
import fc from "fast-check"
import { Context, Effect, Fiber, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { EventHub, type StreamPosition } from "../src/EventHub.ts"

type Step =
  | { readonly kind: "publish"; readonly conversation: number; readonly snapshot: boolean; readonly together: number }
  | { readonly kind: "epoch" }
  | { readonly kind: "subscribe"; readonly resume: boolean }
  | { readonly kind: "disconnect" }

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant("publish" as const), conversation: fc.integer({ min: 0, max: 1 }), snapshot: fc.integer({ min: 0, max: 5 }).map((n) => n === 0), together: fc.integer({ min: 1, max: 3 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("epoch" as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("subscribe" as const), resume: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("disconnect" as const) }) }
)

const after = (a: StreamPosition, b: StreamPosition) => a.epoch > b.epoch || (a.epoch === b.epoch && a.seq > b.seq)
const key = (batch: EventBatch) => `${batch.epoch}:${batch.seq}`
const settle = Effect.gen(function*() {
  for (let index = 0; index < 20; index++) yield* Effect.yieldNow
})

describe("EventHub invariants", () => {
  it("gives every subscriber, late or resuming, a gapless, duplicate-free, ordered stream", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 60, size: "large" }), async (steps) => {
        await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
          const hub = Context.get(yield* Layer.build(EventHub.memory({ logLimit: 4 })), EventHub)
          let epoch = 1
          let seq = 0
          const needsSnapshot = new Set([0, 1])
          const published: Array<EventBatch> = []
          type Subscriber = { start: number; end?: number; cursor?: StreamPosition; received: Array<EventBatch>; fiber: Fiber.Fiber<void> }
          const subscribers: Array<Subscriber> = []
          const disconnected: Array<Subscriber> = []

          for (const current of steps) {
            if (current.kind === "epoch") {
              epoch++
              seq = 0
              needsSnapshot.add(0).add(1)
            } else if (current.kind === "publish") {
              const batches: Array<EventBatch> = []
              for (let index = 0; index < current.together; index++) {
                const snapshot = needsSnapshot.has(current.conversation) || (index === 0 && current.snapshot)
                needsSnapshot.delete(current.conversation)
                batches.push({
                  epoch,
                  seq: ++seq,
                  conversationId: current.conversation,
                  events: [snapshot ? { type: "snapshot" } : { type: "delta", n: seq }] as never
                })
              }
              yield* hub.publish("s", batches)
              published.push(...batches)
            } else if (current.kind === "disconnect") {
              const connected = subscribers.filter((subscriber) => subscriber.end === undefined)
              const leaving = connected.at(-1)
              if (leaving !== undefined) {
                yield* Fiber.interrupt(leaving.fiber)
                leaving.end = published.length
                disconnected.push(leaving)
              }
            } else {
              const previous = disconnected.pop()?.received.at(-1)
              const cursor = current.resume && previous !== undefined ? { epoch: previous.epoch, seq: previous.seq } : undefined
              const received: Array<EventBatch> = []
              const fiber = yield* hub.subscribe("s", cursor).pipe(
                Stream.runForEach((batch) => Effect.sync(() => void received.push(batch))),
                Effect.forkScoped
              )
              subscribers.push({ start: published.length, ...(cursor === undefined ? {} : { cursor }), received, fiber })
            }
            yield* settle
          }

          for (const { start, end, cursor, received } of subscribers) {
            expect(new Set(received.map(key)).size).toBe(received.length)
            for (const conversation of [0, 1]) {
              const mine = received.filter((batch) => batch.conversationId === conversation)
              const all = published.filter((batch) => batch.conversationId === conversation)
              for (let index = 1; index < mine.length; index++) expect(after(mine[index]!, mine[index - 1]!)).toBe(true)
              const live = published.slice(start, end).filter((batch) => batch.conversationId === conversation)
              for (const batch of live) expect(mine.map(key)).toContain(key(batch))
              if (mine.length === 0) continue
              const first = mine[0]!
              const startsAtSnapshot = (first.events[0] as { type: string }).type === "snapshot"
              if (cursor === undefined || !after(first, cursor) || startsAtSnapshot) {
                expect(startsAtSnapshot).toBe(true)
              } else {
                const next = all.find((batch) => after(batch, cursor))
                expect(key(first)).toBe(key(next!))
              }
              const from = all.findIndex((batch) => key(batch) === key(first))
              const until = end === undefined ? all.length : all.findIndex((batch) => published.indexOf(batch) >= end)
              expect(mine.map(key)).toEqual(all.slice(from, until === -1 ? all.length : until).map(key))
            }
          }
        })))
      }),
      { numRuns: 300 }
    )
  })
})
