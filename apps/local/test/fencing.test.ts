import { makeClient } from "@pi-cloud/runner"
import { PiCloud } from "@pi-cloud/client"
import fc from "fast-check"
import { Effect, Exit, Option, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

const TTL = 300
const secret = "fencing-secret"
let deployment: LocalDeployment

beforeAll(async () => {
  deployment = await startLocal({
    port: 41_000 + Math.floor(Math.random() * 10_000),
    // No recovery sweep: the test decides who holds each lease.
    settings: { leaseTtlMs: TTL, recoveryIntervalMs: 600_000, attachTimeoutMs: 5_000 },
    runnerSecret: secret,
    runner: { plugins: [] }
  })
})
afterAll(() => deployment.stop())

type Attempt = { readonly who: "A" | "B"; readonly request: number | null }
const attempt: fc.Arbitrary<Attempt> = fc.record({ who: fc.constantFrom("A" as const, "B" as const), request: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }) })
/** Waves of commits sent concurrently: retries of one request may race each other. */
const waves = fc.array(fc.array(attempt, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 4 })

describe("commit invariants", () => {
  it("applies each commit once, only from the current lease holder, in one gapless sequence", async () => {
    await fc.assert(
      fc.asyncProperty(waves, waves, async (before, after) => {
        await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
          const api = yield* PiCloud
          const rpc = yield* makeClient({ url: deployment.url, secret })
          const { id: sessionId } = yield* api.sessions.create({ payload: {} })
          const attach = (runnerId: string) =>
            Stream.runHead(rpc.Attach({ sessionId, runnerId })).pipe(
              Effect.map((first) => Option.getOrThrow(first)),
              Effect.map((message) => (message._tag === "LeaseGranted" ? message.token : "")),
            )
          const tokens: Record<"A" | "B", string> = { A: yield* attach("A"), B: "not-a-lease" }
          let unique = 0
          const results: Array<{ phase: number; who: "A" | "B"; requestId: string; seq?: number }> = []
          const send = (phase: number, wave: ReadonlyArray<Attempt>) =>
            Effect.forEach(wave, ({ who, request }) => {
              // A request id names one commit across its retries; without one, every attempt is its own commit.
              const requestId = request === null ? `${who}-once-${unique++}` : `${who}-${phase}-${request}`
              return rpc.Storage({ sessionId, token: tokens[who], method: "commit", args: [[]], ...(request === null ? {} : { requestId }) }).pipe(
                Effect.exit,
                Effect.map((exit) => void results.push({ phase, who, requestId, ...(Exit.isSuccess(exit) ? { seq: exit.value.value as number } : {}) }))
              )
            }, { concurrency: "unbounded" })

          for (const wave of before) yield* send(1, wave)
          // A's lease runs out; B takes over. A keeps trying with its old token.
          yield* Effect.sleep(TTL + 100)
          tokens.B = yield* attach("B")
          for (const wave of after) yield* send(2, wave)

          // Only the holder of the live lease ever commits.
          for (const result of results) {
            const holder = result.phase === 1 ? "A" : "B"
            expect(result.seq !== undefined, `${result.who} in phase ${result.phase}`).toBe(result.who === holder)
          }
          // Retries of one request get one answer: it was applied once.
          const byRequest = new Map<string, Set<number>>()
          for (const { requestId, seq } of results) if (seq !== undefined) byRequest.set(requestId, (byRequest.get(requestId) ?? new Set()).add(seq))
          for (const seqs of byRequest.values()) expect(seqs.size).toBe(1)
          // Distinct commits got distinct, gapless sequence numbers, the old holder's before the new one's.
          const applied = [...byRequest.values()].map((seqs) => [...seqs][0]!).sort((a, b) => a - b)
          expect(applied).toEqual(applied.map((_, index) => index + 1))
          const lastOfA = Math.max(0, ...results.filter((result) => result.phase === 1 && result.seq !== undefined).map((result) => result.seq!))
          const firstOfB = Math.min(Infinity, ...results.filter((result) => result.phase === 2 && result.seq !== undefined).map((result) => result.seq!))
          expect(lastOfA).toBeLessThan(firstOfB)
          // And nothing else was applied behind the scenes.
          const next = yield* rpc.Storage({ sessionId, token: tokens.B, method: "commit", args: [[]] })
          expect(next.value).toBe(applied.length + 1)
        }).pipe(Effect.provide(PiCloud.layer({ url: deployment.url })))))
      }),
      { numRuns: 25 }
    )
  }, 120_000)
})
