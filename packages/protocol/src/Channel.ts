import { Schema } from "effect"
import { CommandResult, SessionCommand } from "./Commands.ts"
import { EventBatch } from "./Domain.ts"

export const ChannelRequest = Schema.Union([
  Schema.TaggedStruct("Command", { id: Schema.String, command: SessionCommand }),
  Schema.TaggedStruct("Ping", { id: Schema.String })
])
export type ChannelRequest = typeof ChannelRequest.Type

export const ChannelMessage = Schema.Union([
  Schema.TaggedStruct("Events", { batch: EventBatch }),
  Schema.TaggedStruct("Result", { id: Schema.String, result: CommandResult }),
  Schema.TaggedStruct("Pong", { id: Schema.String }),
  Schema.TaggedStruct("Error", { id: Schema.optional(Schema.String), message: Schema.String })
])
export type ChannelMessage = typeof ChannelMessage.Type

export const channelPath = (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}/channel`
