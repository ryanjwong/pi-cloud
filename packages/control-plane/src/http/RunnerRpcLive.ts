import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Storage } from "@earendil-works/pi-durable"
import { RunnerRpcs, type StorageMethod } from "@pi-cloud/protocol"
import { Effect, Option, Semaphore, Stream } from "effect"
import { ControlPlaneConfig, CredentialStore, EventHub, LeaseManager, StateStore, storageFailure } from "@pi-cloud/core"
import { Runners } from "../Runners.ts"
import { PiServer } from "../services/PiServer.ts"
import { toJson } from "../Sessions.ts"
import { RunnerAuth } from "./Auth.ts"


const call = (storage: Storage, method: StorageMethod, args: ReadonlyArray<unknown>): Promise<unknown> => {
  const fn = (storage as unknown as Record<string, (...args: Array<unknown>) => Promise<unknown>>)[method]
  if (typeof fn !== "function") return Promise.reject(new Error(`Unknown storage method ${method}`))
  // `undefined` travels as `null`; no Storage argument is legitimately `null`.
  return fn.call(storage, ...args.map((arg) => arg === null ? undefined : arg), BACKGROUND_CONTEXT)
}

export const RunnerRpcLive = RunnerRpcs.toLayer(Effect.gen(function*() {
  const runners = yield* Runners
  const leases = yield* LeaseManager
  const states = yield* StateStore
  const events = yield* EventHub
  const auth = yield* RunnerAuth
  const config = yield* ControlPlaneConfig
  const piServer = yield* PiServer
  const credentials = yield* CredentialStore

  /** One commit at a time per session, checked against the lease at the moment it applies. */
  const commitLocks = new Map<string, Semaphore.Semaphore>()
  const commitLock = (sessionId: string) => {
    let lock = commitLocks.get(sessionId)
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1)
      commitLocks.set(sessionId, lock)
    }
    return lock
  }

  return RunnerRpcs.of({
    Attach: (payload, { headers }) => Stream.unwrap(Effect.as(Effect.orDie(auth.check(headers)), runners.attach(payload))),

    Renew: ({ sessionId, token }, { headers }) =>
      auth.check(headers).pipe(
        Effect.orDie,
        Effect.andThen(leases.renew(sessionId, token)),
        Effect.map((lease) => ({ expiresAt: lease.expiresAt }))
      ),

    Release: ({ sessionId, token }, { headers }) =>
      auth.check(headers).pipe(
        Effect.orDie,
        Effect.andThen(leases.release(sessionId, token)),
        Effect.andThen(runners.released(sessionId, token))
      ),

    CredentialGet: ({ sessionId, token, providerId }, { headers }) =>
      Effect.gen(function*() {
        yield* auth.check(headers).pipe(Effect.orDie)
        yield* leases.validate(sessionId, token)
        const found = yield* credentials.get(providerId).pipe(Effect.orDie)
        return Option.match(found, {
          onNone: () => ({ version: 0 }),
          onSome: (entry) => ({ credential: entry.credential, version: entry.version })
        })
      }),

    CredentialList: ({ sessionId, token }, { headers }) =>
      Effect.gen(function*() {
        yield* auth.check(headers).pipe(Effect.orDie)
        yield* leases.validate(sessionId, token)
        const all = yield* credentials.list().pipe(Effect.orDie)
        return all.map((entry) => ({ providerId: entry.providerId, type: entry.credential.type }))
      }),

    CredentialPut: ({ sessionId, token, providerId, version, credential }, { headers }) =>
      Effect.gen(function*() {
        yield* auth.check(headers).pipe(Effect.orDie)
        yield* leases.validate(sessionId, token)
        return yield* credentials.put(providerId, credential, version).pipe(Effect.orDie)
      }),

    ServiceUpdate: ({ sessionId, token, attachmentId, subscriptionId, update }, { headers }) =>
      Effect.gen(function*() {
        yield* auth.check(headers).pipe(Effect.orDie)
        yield* leases.validate(sessionId, token)
        yield* piServer.publish(attachmentId, subscriptionId, update)
      }),

    Reply: ({ sessionId, token, commandId, result }, { headers }) =>
      auth.check(headers).pipe(Effect.orDie, Effect.andThen(runners.reply(sessionId, token, commandId, result))),

    Publish: ({ sessionId, token, batches }, { headers }) =>
      Effect.gen(function*() {
        yield* auth.check(headers).pipe(Effect.orDie)
        yield* leases.validate(sessionId, token)
        const { needsSnapshot } = yield* events.publish(sessionId, batches)
        if (needsSnapshot) yield* runners.notify(sessionId, { _tag: "Resnapshot" })
      }),

    Storage: ({ sessionId, token, method, args }, { headers }) =>
      Effect.gen(function*() {
        yield* auth.check(headers).pipe(Effect.orDie)
        yield* leases.validate(sessionId, token)
        const storage = yield* states.open(sessionId)
        const run = Effect.tryPromise({ try: () => call(storage, method, args), catch: storageFailure })
        const value = method === "commit"
          ? yield* commitLock(sessionId).withPermits(1)(Effect.andThen(leases.validate(sessionId, token), run))
          : yield* run
        return { value: toJson(value) as never }
      }).pipe(Effect.withSpan("RunnerRpc.Storage", { attributes: { method, leaseTtl: config.leaseTtlMs } }))
  })
}))

