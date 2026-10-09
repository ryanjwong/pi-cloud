import type { JsonValue } from "@earendil-works/chord"
import type { StorageFailure } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Option } from "effect"

/**
 * Ties something outside pi-cloud (a GitHub pull request, a Slack thread, a Linear issue) to the session that
 * handles it, so every later event about the same thing reaches the same session.
 */
export interface Binding {
  /** Stable external identity, e.g. `github:acme/api#42` or `slack:T1:C2:1700000000.000100`. */
  readonly key: string
  readonly sessionId: string
  /** The source that replies here, if any. Triggers bind without one. */
  readonly source?: string | undefined
  /** Where the source delivers replies (channel, thread, ...). Source-specific JSON. */
  readonly target?: JsonValue | undefined
  /** Newest transcript entry already delivered through the source. */
  readonly delivered?: number | undefined
  readonly createdAt: number
}

export class BindingStore extends Context.Service<BindingStore, {
  get(key: string): Effect.Effect<Option.Option<Binding>, StorageFailure>
  put(binding: Binding): Effect.Effect<void, StorageFailure>
  /** Every binding, or those of one source. */
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
