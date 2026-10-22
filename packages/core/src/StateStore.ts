import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable"
import type { StorageDump, StorageFailure } from "@pi-cloud/protocol"
import { Context, Effect, Layer } from "effect"
import { storageFailure } from "./SessionStore.ts"

export class StateStore extends Context.Service<StateStore, {
  open(sessionId: string): Effect.Effect<Storage, StorageFailure>
  remove(sessionId: string): Effect.Effect<void, StorageFailure>
  dump(sessionId: string): Effect.Effect<StorageDump | undefined, StorageFailure>
}>()("@pi-cloud/control-plane/StateStore") {
  static readonly fromOpener = (options: {
    readonly open: (sessionId: string) => Promise<Storage>
    readonly remove?: (sessionId: string) => Promise<void>
    readonly dump?: (sessionId: string) => Promise<StorageDump>
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
        const dump = (sessionId: string) =>
          Effect.tryPromise({
            try: async () => {
              if (options.dump === undefined) return undefined
              await open(sessionId).pipe(Effect.runPromise)
              return options.dump(sessionId)
            },
            catch: storageFailure
          })
        return StateStore.of({ open, remove, dump })
      })
    )

  static readonly memory: Layer.Layer<StateStore> = StateStore.fromOpener({
    open: async () => new MemoryStorage()
  })
}
