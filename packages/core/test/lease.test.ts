import fc from "fast-check"
import { Context, Effect, Exit, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import { type Lease, LeaseManager } from "../src/LeaseManager.ts"
import { manualClock } from "./clock.ts"

const TTL = 1_000
const SESSIONS = ["s0", "s1"]
const RUNNERS = ["r0", "r1", "r2"]

type Op =
  | { readonly op: "acquire"; readonly session: number; readonly runner: number; readonly token: "latest" | "none" | "oldest" }
  | { readonly op: "renew" | "release" | "validate"; readonly session: number; readonly runner: number; readonly token: "latest" | "oldest" }
  | { readonly op: "advance"; readonly ms: number }
  | { readonly op: "takeAbandoned" }
  | { readonly op: "remove"; readonly session: number }

const session = fc.integer({ min: 0, max: SESSIONS.length - 1 })
const runner = fc.integer({ min: 0, max: RUNNERS.length - 1 })
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ op: fc.constant("acquire" as const), session, runner, token: fc.constantFrom("latest" as const, "none" as const, "oldest" as const) }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constantFrom("renew" as const, "release" as const, "validate" as const), session, runner, token: fc.constantFrom("latest" as const, "oldest" as const) }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("advance" as const), ms: fc.oneof(fc.integer({ min: 0, max: 2 * TTL }), fc.constantFrom(TTL - 1, TTL, TTL + 1)) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("takeAbandoned" as const) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("remove" as const), session }) }
)

class Model {
  leases = new Map<string, { runner: string; token: string; epoch: number; expiresAt: number }>()
  epochs = new Map<string, number>()
  reported = new Set<string>()
  live(sessionId: string, now: number) {
    const lease = this.leases.get(sessionId)
    return lease !== undefined && lease.expiresAt > now ? lease : undefined
  }
}

describe("LeaseManager invariants", () => {
  it("matches the specification and keeps one writer per session under any sequence of operations", () => {
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 80, size: "large" }), (ops) => {
        const time = manualClock()
        const leases = Context.get(Effect.runSync(Effect.scoped(Layer.build(LeaseManager.memory({ ttlMs: TTL })))), LeaseManager)
        const model = new Model()
        const held = new Map<string, Array<string>>()
        const heldBy = (s: string, r: string) => held.get(`${s}/${r}`) ?? []
        const issued = new Map<string, Array<Lease>>()
        const tokens = new Set<string>()

        for (const step of ops) {
          const now = time.now()
          switch (step.op) {
            case "advance":
              time.advance(step.ms)
              break
            case "acquire": {
              const s = SESSIONS[step.session]!
              const r = RUNNERS[step.runner]!
              const mine = heldBy(s, r)
              const token = step.token === "none" ? undefined : step.token === "latest" ? mine.at(-1) : mine[0]
              const exit = time.run(leases.acquire(s, r, token))
              const live = model.live(s, now)
              if (live === undefined) {
                expect(Exit.isSuccess(exit)).toBe(true)
                const lease = (exit as Exit.Success<Lease>).value
                const epoch = (model.epochs.get(s) ?? 0) + 1
                expect(lease.epoch).toBe(epoch)
                expect(lease.runnerId).toBe(r)
                expect(lease.expiresAt).toBe(now + TTL)
                expect(tokens.has(lease.token)).toBe(false)
                tokens.add(lease.token)
                model.epochs.set(s, epoch)
                model.leases.set(s, { runner: r, token: lease.token, epoch, expiresAt: now + TTL })
                model.reported.delete(s)
                held.set(`${s}/${r}`, [...mine, lease.token])
                issued.set(s, [...(issued.get(s) ?? []), lease])
              } else if (token !== undefined && token === live.token) {
                expect(Exit.isSuccess(exit)).toBe(true)
                const lease = (exit as Exit.Success<Lease>).value
                expect([lease.token, lease.epoch, lease.expiresAt]).toEqual([live.token, live.epoch, now + TTL])
                live.expiresAt = now + TTL
              } else {
                expect(Exit.isFailure(exit)).toBe(true)
              }
              break
            }
            case "renew":
            case "validate":
            case "release": {
              const s = SESSIONS[step.session]!
              const mine = heldBy(s, RUNNERS[step.runner]!)
              const token = step.token === "latest" ? mine.at(-1) : mine[0]
              if (token === undefined) break
              const live = model.live(s, now)
              if (step.op === "release") {
                time.run(leases.release(s, token))
                if (model.leases.get(s)?.token === token) model.leases.delete(s)
                break
              }
              const exit = time.run(step.op === "renew" ? leases.renew(s, token) : leases.validate(s, token))
              const ok = live !== undefined && live.token === token
              expect(Exit.isSuccess(exit)).toBe(ok)
              if (ok && step.op === "renew") live!.expiresAt = now + TTL
              break
            }
            case "takeAbandoned": {
              const exit = time.run(leases.takeAbandoned())
              const expected: Array<string> = []
              for (const [s, lease] of model.leases) {
                if (lease.expiresAt <= now && !model.reported.has(s)) {
                  model.reported.add(s)
                  expected.push(s)
                }
              }
              expect([...(exit as Exit.Success<ReadonlyArray<string>>).value].sort()).toEqual(expected.sort())
              break
            }
            case "remove": {
              const s = SESSIONS[step.session]!
              time.run(leases.remove(s))
              model.leases.delete(s)
              model.reported.delete(s)
              break
            }
          }

          const after = time.now()
          for (const s of SESSIONS) {
            const all = issued.get(s) ?? []
            for (let index = 1; index < all.length; index++) expect(all[index]!.epoch).toBeGreaterThan(all[index - 1]!.epoch)
            const valid = all.filter((lease) => Exit.isSuccess(time.run(leases.validate(s, lease.token))))
            expect(valid.length).toBeLessThanOrEqual(1)
            if (valid.length === 1) expect(valid[0]!.token).toBe(all.at(-1)!.token)
            const current = time.run(leases.current(s)) as Exit.Success<Option.Option<Lease>>
            expect(Option.getOrUndefined(current.value)?.token).toBe(model.live(s, after)?.token)
          }
        }
      }),
      { numRuns: 500 }
    )
  })
})
