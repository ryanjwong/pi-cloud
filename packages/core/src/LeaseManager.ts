import { LeaseHeld, LeaseLost } from "@pi-cloud/protocol"
import { Clock, Context, Effect, Layer, Option } from "effect"

export interface Lease {
  readonly sessionId: string
  readonly runnerId: string
  readonly token: string
  readonly epoch: number
  readonly expiresAt: number
}

export class LeaseManager extends Context.Service<LeaseManager, {
  acquire(sessionId: string, runnerId: string, token: string | undefined): Effect.Effect<Lease, LeaseHeld>
  renew(sessionId: string, token: string): Effect.Effect<Lease, LeaseLost>
  release(sessionId: string, token: string): Effect.Effect<void>
  validate(sessionId: string, token: string): Effect.Effect<Lease, LeaseLost>
  current(sessionId: string): Effect.Effect<Option.Option<Lease>>
  takeAbandoned(): Effect.Effect<ReadonlyArray<string>>
  remove(sessionId: string): Effect.Effect<void>
}>()("@pi-cloud/control-plane/LeaseManager") {
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
