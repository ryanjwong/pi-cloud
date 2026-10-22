import type { JsonValue } from "@earendil-works/chord"
import type { StorageFailure } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Option } from "effect"

export interface Binding {
  readonly key: string
  readonly sessionId: string
  readonly source?: string | undefined
  readonly target?: JsonValue | undefined
  readonly delivered?: number | undefined
  readonly createdAt: number
}

export class BindingStore extends Context.Service<BindingStore, {
  get(key: string): Effect.Effect<Option.Option<Binding>, StorageFailure>
  put(binding: Binding): Effect.Effect<void, StorageFailure>
  list(source?: string): Effect.Effect<ReadonlyArray<Binding>, StorageFailure>
  remove(key: string): Effect.Effect<void, StorageFailure>
}>()("@pi-cloud/core/BindingStore") {
  static readonly memory: Layer.Layer<BindingStore> = Layer.sync(BindingStore, () => {
    const bindings = new Map<string, Binding>()
    return BindingStore.of({
      get: (key) => Effect.sync(() => Option.fromUndefinedOr(bindings.get(key))),
      put: (binding) => Effect.sync(() => void bindings.set(binding.key, binding)),
      list: (source) =>
        Effect.sync(() => [...bindings.values()].filter((binding) => source === undefined || binding.source === source)),
      remove: (key) => Effect.sync(() => void bindings.delete(key))
    })
  })
}
