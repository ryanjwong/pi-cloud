import { LeaseHeld, LeaseLost } from "@pi-cloud/protocol"
import { Clock, Context, Effect, Layer, Option } from "effect"

export interface Lease {
  readonly sessionId: string
  readonly runnerId: string
  /** Fencing token: writes are accepted only from the current token. */
  readonly token: string
  /** Increases with every new lease on the session. */
  readonly epoch: number
  readonly expiresAt: number
}

/**
 * Decides which runner may write to a session. There is at most one live lease per session; a lease that is not
 * renewed before it expires can be taken by another runner, and every later write with the old token fails.
 */
export class LeaseManager extends Context.Service<LeaseManager, {
  /** Take the lease, or renew it when `token` is the current one. */
  acquire(sessionId: string, runnerId: string, token: string | undefined): Effect.Effect<Lease, LeaseHeld>
  renew(sessionId: string, token: string): Effect.Effect<Lease, LeaseLost>
  /** Give the lease up cleanly: the runner finished all work it knew about. */
  release(sessionId: string, token: string): Effect.Effect<void>
  /** Fail unless `token` holds the session's lease right now. */
  validate(sessionId: string, token: string): Effect.Effect<Lease, LeaseLost>
  current(sessionId: string): Effect.Effect<Option.Option<Lease>>
  /**
   * Sessions whose lease expired without a release since the last call: their runner died, possibly mid-run,
   * so they should be woken to resume.
   */
  takeAbandoned(): Effect.Effect<ReadonlyArray<string>>
  /** Forget the session entirely. */
  remove(sessionId: string): Effect.Effect<void>
}>()("@pi-cloud/control-plane/LeaseManager") {
  /**
   * Leases in process memory. Correct for one control-plane process; a horizontally scaled control plane needs
   * a shared implementation whose check is atomic with the state store's commit.
   */
  static readonly memory = (options: { readonly ttlMs: number }): Layer.Layer<LeaseManager> =>
    Layer.sync(LeaseManager, () => {
      const leases = new Map<string, Lease>()
      const epochs = new Map<string, number>()
      const reported = new Set<string>()

      const live = (sessionId: string, now: number) => {
        const lease = leases.get(sessionId)
        return lease !== undefined && lease.expiresAt > now ? lease : undefined
      }

      const grant = (sessionId: string, runnerId: string, now: number): Lease => {
        const epoch = (epochs.get(sessionId) ?? 0) + 1
        epochs.set(sessionId, epoch)
        reported.delete(sessionId)
        const lease = { sessionId, runnerId, token: crypto.randomUUID(), epoch, expiresAt: now + options.ttlMs }
        leases.set(sessionId, lease)
        return lease
      }

      const extend = (lease: Lease, now: number): Lease => {
        const next = { ...lease, expiresAt: now + options.ttlMs }
        leases.set(lease.sessionId, next)
        return next
      }

      return LeaseManager.of({
        acquire: (sessionId, runnerId, token) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => {
            const lease = live(sessionId, now)
            if (lease === undefined) return Effect.succeed(grant(sessionId, runnerId, now))
            if (token !== undefined && lease.token === token) return Effect.succeed(extend(lease, now))
            return Effect.fail(new LeaseHeld({ sessionId, holder: lease.runnerId }))
          }),
        renew: (sessionId, token) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => {
            const lease = live(sessionId, now)
            return lease?.token === token ? Effect.succeed(extend(lease, now)) : Effect.fail(new LeaseLost({ sessionId }))
          }),
        release: (sessionId, token) =>
          Effect.sync(() => {
            if (leases.get(sessionId)?.token === token) leases.delete(sessionId)
          }),
        validate: (sessionId, token) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => {
            const lease = live(sessionId, now)
            return lease?.token === token ? Effect.succeed(lease) : Effect.fail(new LeaseLost({ sessionId }))
          }),
        current: (sessionId) => Effect.map(Clock.currentTimeMillis, (now) => Option.fromUndefinedOr(live(sessionId, now))),
        takeAbandoned: () =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            const abandoned: Array<string> = []
            for (const [sessionId, lease] of leases) {
              if (lease.expiresAt <= now && !reported.has(sessionId)) {
                reported.add(sessionId)
                abandoned.push(sessionId)
              }
            }
            return abandoned
          }),
        remove: (sessionId) =>
          Effect.sync(() => {
            leases.delete(sessionId)
            reported.delete(sessionId)
          })
      })
    })
}
