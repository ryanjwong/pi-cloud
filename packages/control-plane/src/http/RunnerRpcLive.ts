import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { Storage } from "@earendil-works/pi-durable"
import { RunnerRpcs, type SessionId, type StorageMethod } from "@pi-cloud/protocol"
import { Effect, Option, Semaphore, Stream } from "effect"
import { ControlPlaneConfig, CredentialStore, EventHub, LeaseManager, SessionSecrets, SessionStore, StateStore, storageFailure } from "@pi-cloud/core"
import { Runners } from "../Runners.ts"
import { toJson } from "../Sessions.ts"
import { RunnerAuth } from "./Auth.ts"


const call = (storage: Storage, method: StorageMethod, args: ReadonlyArray<unknown>): Promise<unknown> => {
  const fn = (storage as unknown as Record<string, (...args: Array<unknown>) => Promise<unknown>>)[method]
  if (typeof fn !== "function") return Promise.reject(new Error(`Unknown storage method ${method}`))
  return fn.call(storage, ...args.map((arg) => arg === null ? undefined : arg), BACKGROUND_CONTEXT)
}

export const RunnerRpcLive = RunnerRpcs.toLayer(Effect.gen(function*() {
  const runners = yield* Runners
  const leases = yield* LeaseManager
  const states = yield* StateStore
  const events = yield* EventHub
  const auth = yield* RunnerAuth
  const config = yield* ControlPlaneConfig
  const credentials = yield* CredentialStore
  const sessionSecrets = yield* SessionSecrets
  const store = yield* SessionStore

  const commits = new Map<string, Map<string, unknown>>()
  const remember = (sessionId: string, requestId: string, value: unknown) => {
    let recent = commits.get(sessionId)
    if (recent === undefined) commits.set(sessionId, recent = new Map())
    recent.set(requestId, value)
    if (recent.size > 64) recent.delete(recent.keys().next().value!)
  }

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

    SessionSecret: ({ sessionId, token, name }, { headers }) =>
      Effect.gen(function*() {
        yield* auth.check(headers).pipe(Effect.orDie)
        yield* leases.validate(sessionId, token)
        const session = yield* store.get(sessionId as SessionId)
        if (Option.isNone(session) || session.value.resolved?.untrusted === true) return {}
        const issued = yield* sessionSecrets.issue(session.value, name)
        return Option.match(issued, {
          onNone: () => ({}),
          onSome: (secret) => ({ value: secret.value, ...(secret.expiresAt === undefined ? {} : { expiresAt: secret.expiresAt }) })
        })
      }),

    Frames: ({ sessionId, token, link, frames }, { headers }) =>
      auth.check(headers).pipe(Effect.orDie, Effect.andThen(runners.frames(sessionId, token, link, frames))),

    Reply: ({ sessionId, token, commandId, result }, { headers }) =>
      auth.check(headers).pipe(Effect.orDie, Effect.andThen(runners.reply(sessionId, token, commandId, result))),

    Publish: ({ sessionId, token, batches }, { headers }) =>
      Effect.gen(function*() {
        yield* auth.check(headers).pipe(Effect.orDie)
        yield* leases.validate(sessionId, token)
        const { needsSnapshot } = yield* events.publish(sessionId, batches)
        if (needsSnapshot) yield* runners.notify(sessionId, { _tag: "Resnapshot" })
      }),

    StorageDump: ({ sessionId, token }, { headers }) =>
      Effect.gen(function*() {
        yield* auth.check(headers).pipe(Effect.orDie)
        const dump = yield* commitLock(sessionId).withPermits(1)(
          Effect.andThen(leases.validate(sessionId, token), states.dump(sessionId))
        )
        return dump === undefined ? {} : { dump }
      }),

    Storage: ({ sessionId, token, method, args, requestId }, { headers }) =>
      Effect.gen(function*() {
        yield* auth.check(headers).pipe(Effect.orDie)
        yield* leases.validate(sessionId, token)
        const storage = yield* states.open(sessionId)
        const run = Effect.tryPromise({ try: () => call(storage, method, args), catch: storageFailure })
        const value = method === "commit"
          ? yield* commitLock(sessionId).withPermits(1)(Effect.gen(function*() {
            yield* leases.validate(sessionId, token)
            const recent = requestId === undefined ? undefined : commits.get(sessionId)
            if (recent?.has(requestId!) === true) return recent.get(requestId!)
            const seq = yield* run
            if (requestId !== undefined) remember(sessionId, requestId, seq)
            return seq
          }))
          : yield* run
        return { value: toJson(value) as never }
      }).pipe(Effect.withSpan("RunnerRpc.Storage", { attributes: { method, leaseTtl: config.leaseTtlMs } }))
  })
}))

