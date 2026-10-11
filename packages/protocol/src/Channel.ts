import { Schema } from "effect"
import { CommandResult, SessionCommand } from "./Commands.ts"
import { EventBatch } from "./Domain.ts"
import { ViewUpdate } from "./View.ts"

/**
 * The session channel: one WebSocket per attached client at `GET /v1/sessions/{id}/channel`, carrying JSON text
 * frames both ways. A client sends commands and receives their results plus the session's live events, which is
 * everything an interactive surface (a TUI, a web UI, a chat bridge) needs.
 *
 * On connect the server first replays buffered events (from the newest snapshot, or after `?after=<epoch>:<seq>`
 * when that gap is still buffered), then streams live batches. Commands may be sent at any time; results carry the
 * client's `id` and may arrive in any order relative to events.
 *
 * `Watch` subscribes the connection to the view of a conversation (see `View.ts`): the server answers with `View`
 * messages, the session state first, each state starting with a snapshot. Watch several conversations to switch
 * between them; `Unwatch` stops one.
 */

/** Client → server. */
export const ChannelRequest = Schema.Union([
  Schema.TaggedStruct("Command", { id: Schema.String, command: SessionCommand }),
  Schema.TaggedStruct("Ping", { id: Schema.String }),
  /** Receive the view of a conversation (default: the root) and the session state. */
  Schema.TaggedStruct("Watch", { conversationId: Schema.optional(Schema.Number) }),
  Schema.TaggedStruct("Unwatch", { conversationId: Schema.optional(Schema.Number) })
])
export type ChannelRequest = typeof ChannelRequest.Type

/** Server → client. */
export const ChannelMessage = Schema.Union([
  Schema.TaggedStruct("Events", { batch: EventBatch }),
  Schema.TaggedStruct("Result", { id: Schema.String, result: CommandResult }),
  Schema.TaggedStruct("Pong", { id: Schema.String }),
  Schema.TaggedStruct("View", { update: ViewUpdate }),
  /** A request that could not be decoded, or a failure outside any command. */
  Schema.TaggedStruct("Error", { id: Schema.optional(Schema.String), message: Schema.String })
])
export type ChannelMessage = typeof ChannelMessage.Type

export const channelPath = (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}/channel`
