import { Schema } from "effect"

/**
 * The view: everything a presentation renders, kept in sync by the control plane. Pi's TUI is a projection of it,
 * and so can be any web or chat UI.
 *
 * A view has two kinds of state:
 *
 * - the **session state** (`SessionViewState`): the session's conversations, the models its runner can use,
 *   notices, and the live task graph;
 * - one **conversation view** per conversation: Pi Durable's `Conversation.viewState()`, the structural transcript
 *   of the active context (`entries`) with the documents presentations need (`docs["pi.live"]` for the streaming
 *   message, running tools, retries and compaction; `pi.inbox` for queued input; `pi.agent` for model, thinking
 *   level and instructions; `pi.usage` for token usage and cost).
 *
 * Each state travels as a `Snapshot` followed by `Ops`: Chord delta operations against the previous value, applied
 * with `applyImmutable` from `@earendil-works/chord/delta`. The view is computed on the session's runner, in the
 * cloud; watching a conversation of a session with no runner starts one.
 */

export const ViewConversation = Schema.Struct({
  id: Schema.Number,
  /** `main` for the root conversation, `subagent N` for a subagent's. */
  label: Schema.String,
  /** The conversation's first user message; for a subagent, its task. */
  title: Schema.optional(Schema.String)
})
export type ViewConversation = typeof ViewConversation.Type

export const ViewModel = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  name: Schema.String,
  contextWindow: Schema.Number,
  /** Thinking levels the model supports, in order; `["off"]` for a model without reasoning. */
  thinkingLevels: Schema.Array(Schema.String)
})
export type ViewModel = typeof ViewModel.Type

export const ViewNotice = Schema.Struct({
  id: Schema.Number,
  level: Schema.Literals(["info", "warning", "error"]),
  message: Schema.String
})
export type ViewNotice = typeof ViewNotice.Type

export const SessionViewState = Schema.Struct({
  conversations: Schema.Array(ViewConversation),
  /** Models the session's runner has credentials for. */
  models: Schema.Array(ViewModel),
  /** The newest notices: prompts that ended without an answer, compaction outcomes, runner warnings. */
  notices: Schema.Array(ViewNotice),
  /** Pi Durable's live `TaskGraph`: every live task, what it waits on, and the conversations it owns. */
  tasks: Schema.optional(Schema.Json)
})
export type SessionViewState = typeof SessionViewState.Type

export const ViewFrame = Schema.Union([
  /** The whole state. */
  Schema.TaggedStruct("Snapshot", { value: Schema.Json }),
  /** Chord delta operations against the previous state. */
  Schema.TaggedStruct("Ops", { ops: Schema.Array(Schema.Json) })
])
export type ViewFrame = typeof ViewFrame.Type

export const ViewUpdate = Schema.Struct({
  /** Changes whenever a new runner takes over; its updates start again from snapshots. */
  epoch: Schema.Number,
  /** Increases within an epoch. */
  seq: Schema.Number,
  /** The conversation this update is about; absent for the session state. */
  conversationId: Schema.optional(Schema.Number),
  frame: ViewFrame
})
export type ViewUpdate = typeof ViewUpdate.Type
