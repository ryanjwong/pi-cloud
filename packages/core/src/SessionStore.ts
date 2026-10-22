import { StorageRequestError } from "@earendil-works/pi-durable"
import type { Session, SessionId } from "@pi-cloud/protocol"
import { StorageFailure } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Option } from "effect"

export class SessionStore extends Context.Service<SessionStore, {
  put(session: Session): Effect.Effect<void, StorageFailure>
  get(id: SessionId): Effect.Effect<Option.Option<Session>, StorageFailure>
  list(): Effect.Effect<ReadonlyArray<Session>, StorageFailure>
  remove(id: SessionId): Effect.Effect<void, StorageFailure>
}>()("@pi-cloud/control-plane/SessionStore") {
  static readonly memory: Layer.Layer<SessionStore> = Layer.sync(SessionStore, () => {
    const sessions = new Map<string, Session>()
    return SessionStore.of({
      put: (session) => Effect.sync(() => void sessions.set(session.id, session)),
      get: (id) => Effect.sync(() => Option.fromUndefinedOr(sessions.get(id))),
      list: () => Effect.sync(() => [...sessions.values()]),
      remove: (id) => Effect.sync(() => void sessions.delete(id))
    })
  })
}

export const storageFailure = (cause: unknown) =>
  new StorageFailure({
    message: cause instanceof Error ? cause.message : String(cause),
    ...(cause instanceof StorageRequestError ? { request: true } : {})
  })
