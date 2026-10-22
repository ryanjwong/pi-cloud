import { Clock, Effect } from "effect"

export const manualClock = (start = 1_000_000) => {
  let now = start
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: () => Effect.void
  }
  return {
    clock,
    now: () => now,
    advance: (ms: number) => void (now += ms),
    run: <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(Effect.exit(Effect.provideService(effect, Clock.Clock, clock)))
  }
}
