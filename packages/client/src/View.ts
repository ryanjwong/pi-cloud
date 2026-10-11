import type { JsonValue } from "@earendil-works/chord"
import { applyImmutable, type Op } from "@earendil-works/chord/delta"
import type { SessionViewState, ViewUpdate } from "@pi-cloud/protocol"

interface Replica {
  epoch: number
  value: JsonValue
}

/**
 * A local copy of a session's view, kept current by applying `ViewUpdate`s from the channel's `Watch` or the
 * `GET /v1/sessions/{id}/view` stream. Each conversation's value is Pi Durable's `ConversationView`.
 */
export class ViewReplica {
  readonly #conversations = new Map<number, Replica>()
  #session: Replica | undefined
  readonly #listeners = new Set<() => void>()

  /** Apply one update. Operations without the snapshot they build on are ignored; a new snapshot follows them. */
  apply(update: ViewUpdate): void {
    const current = update.conversationId === undefined ? this.#session : this.#conversations.get(update.conversationId)
    let next: Replica
    if (update.frame._tag === "Snapshot") next = { epoch: update.epoch, value: update.frame.value as JsonValue }
    else if (current === undefined || current.epoch !== update.epoch) return
    else next = { epoch: update.epoch, value: applyImmutable(current.value, update.frame.ops as unknown as Array<Op>) }
    if (update.conversationId === undefined) this.#session = next
    else this.#conversations.set(update.conversationId, next)
    for (const listener of this.#listeners) listener()
  }

  /** The session state, once received. */
  get session(): SessionViewState | undefined {
    return this.#session?.value as SessionViewState | undefined
  }

  /** A watched conversation's `ConversationView`, once received. */
  conversation<T = unknown>(id: number): T | undefined {
    return this.#conversations.get(id)?.value as T | undefined
  }

  /** Called after every applied update. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}
