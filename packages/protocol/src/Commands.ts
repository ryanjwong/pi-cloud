import { Schema } from "effect"
import { ModelRef, UserContent, WhenBusy } from "./Domain.ts"

/**
 * Everything a client can ask a running session to do. The same commands travel over REST (`POST .../commands`),
 * the WebSocket session channel, and the runner RPC, so every surface has the same capabilities.
 *
 * Every command may name a conversation; without one it targets the session's root conversation.
 */
const target = { conversationId: Schema.optional(Schema.Number) }

/** Send user input. Busy conversations queue it as a follow-up, steer the running turn, or reject it. */
export const PromptCommand = Schema.TaggedStruct("Prompt", {
  ...target,
  content: UserContent,
  /** Makes the submission exactly-once: a retry with the same id returns the original submission. */
  requestId: Schema.optional(Schema.String),
  whenBusy: Schema.optional(WhenBusy)
})

/** Abort the conversation's running turn and its queued inputs. */
export const AbortCommand = Schema.TaggedStruct("Abort", { ...target })

/** Change the conversation's agent: model, thinking level, instructions. `null` clears a field. */
export const ConfigureCommand = Schema.TaggedStruct("Configure", {
  ...target,
  model: Schema.optional(Schema.NullOr(ModelRef)),
  thinkingLevel: Schema.optional(Schema.NullOr(Schema.String)),
  instructions: Schema.optional(Schema.NullOr(Schema.String))
})

/** Summarize older messages now, optionally with instructions for the summary. */
export const CompactCommand = Schema.TaggedStruct("Compact", {
  ...target,
  instructions: Schema.optional(Schema.String)
})

/** Start a fresh context, optionally carrying a handoff note. The older transcript stays in storage. */
export const ResetCommand = Schema.TaggedStruct("Reset", {
  ...target,
  handoff: Schema.optional(Schema.String)
})

/** A command handled by a runner plugin, by name. */
export const CustomCommand = Schema.TaggedStruct("Custom", {
  name: Schema.String,
  payload: Schema.Json
})

export const SessionCommand = Schema.Union([
  PromptCommand,
  AbortCommand,
  ConfigureCommand,
  CompactCommand,
  ResetCommand,
  CustomCommand
])
export type SessionCommand = typeof SessionCommand.Type

/** Outcome of a command: its value, or a tagged error such as `ConversationBusy`. */
export const CommandResult = Schema.Union([
  Schema.TaggedStruct("Ok", { value: Schema.optional(Schema.Json) }),
  Schema.TaggedStruct("Err", { tag: Schema.String, message: Schema.String })
])
export type CommandResult = typeof CommandResult.Type

/** Value of a successful `Prompt`. */
export const Submitted = Schema.Struct({
  submissionId: Schema.Number,
  conversationId: Schema.Number
})
export type Submitted = typeof Submitted.Type
