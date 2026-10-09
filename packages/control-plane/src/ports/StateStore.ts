import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable"
import type { StorageFailure } from "@pi-cloud/protocol"
import { Context, Effect, Layer } from "effect"
import { storageFailure } from "./SessionStore.ts"

/**
 * Where each session's durable agent state lives. An implementation hands out one Pi Durable `Storage` per
 * session, so any backend that passes Pi's storage conformance suite plugs in here: memory, SQLite, Postgres,
 * an object store, ...
 *
 * The control plane is the only process that touches these stores. Runners reach them through the fenced
 * storage RPC, so a backend needs no locking of its own: the control plane serializes each session's commits
 * and checks the writer's lease before applying them.
 */
export class StateStore extends Context.Service<StateStore, {
  /** The session's storage, opened on first use and shared afterwards. */
  open(sessionId: string): Effect.Effect<Storage, StorageFailure>
  /** Close and delete the session's state. */
  remove(sessionId: string): Effect.Effect<void, StorageFailure>
}>()("@pi-cloud/control-plane/StateStore") {
  /** Build a `StateStore` from a function that opens one session's storage. Opened stores close with the layer. */
  static readonly fromOpener = (options: {
    readonly open: (sessionId: string) => Promise<Storage>
    readonly remove?: (sessionId: string) => Promise<void>
  }): Layer.Layer<StateStore> =>
    Layer.effect(
      StateStore,
      Effect.gen(function*() {
        const opened = new Map<string, Promise<Storage>>()
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            Promise.allSettled([...opened.values()].map(async (storage) => (await storage).close(BACKGROUND_CONTEXT)))
          )
        )
        const open = (sessionId: string) =>
          Effect.tryPromise({
            try: () => {
              let storage = opened.get(sessionId)
              if (storage === undefined) {
                storage = options.open(sessionId)
                storage.catch(() => opened.delete(sessionId))
                opened.set(sessionId, storage)
              }
              return storage
            },
            catch: storageFailure
          })
        const remove = (sessionId: string) =>
          Effect.tryPromise({
            try: async () => {
              const storage = opened.get(sessionId)
              opened.delete(sessionId)
              if (storage !== undefined) await (await storage).close(BACKGROUND_CONTEXT)
              await options.remove?.(sessionId)
            },
            catch: storageFailure
          })
        return StateStore.of({ open, remove })
      })
    )

  /** Pi's in-memory storage per session. Nothing survives a restart. */
  static readonly memory: Layer.Layer<StateStore> = StateStore.fromOpener({
    open: async () => new MemoryStorage()
  })
}
