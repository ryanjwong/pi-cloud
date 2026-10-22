import { Schema } from "effect"
import { ModelRef, UserContent, WhenBusy } from "./Domain.ts"

const target = { conversationId: Schema.optional(Schema.Number) }

export const PromptCommand = Schema.TaggedStruct("Prompt", {
  ...target,
  content: UserContent,
  requestId: Schema.optional(Schema.String),
  whenBusy: Schema.optional(WhenBusy)
})

export const AbortCommand = Schema.TaggedStruct("Abort", { ...target })

export const ConfigureCommand = Schema.TaggedStruct("Configure", {
  ...target,
  model: Schema.optional(Schema.NullOr(ModelRef)),
  thinkingLevel: Schema.optional(Schema.NullOr(Schema.String)),
  instructions: Schema.optional(Schema.NullOr(Schema.String))
})

export const CompactCommand = Schema.TaggedStruct("Compact", {
  ...target,
  instructions: Schema.optional(Schema.String)
})

export const ResetCommand = Schema.TaggedStruct("Reset", {
  ...target,
  handoff: Schema.optional(Schema.String)
})

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

export const CommandResult = Schema.Union([
  Schema.TaggedStruct("Ok", { value: Schema.optional(Schema.Json) }),
  Schema.TaggedStruct("Err", { tag: Schema.String, message: Schema.String })
])
export type CommandResult = typeof CommandResult.Type

export const Submitted = Schema.Struct({
  submissionId: Schema.Number,
  conversationId: Schema.Number
})
export type Submitted = typeof Submitted.Type
