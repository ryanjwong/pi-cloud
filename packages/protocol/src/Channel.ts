import { Schema } from "effect"
import { CommandResult, SessionCommand } from "./Commands.ts"
import { EventBatch } from "./Domain.ts"
import { WorkspaceCall, WorkspaceEvent } from "./Workspace.ts"

/**
 * The session channel: one WebSocket per attached client at `GET /v1/sessions/{id}/channel`, carrying JSON text
 * frames both ways. A client sends commands and receives their results plus the session's live events, which is
 * everything an interactive surface (a TUI, a web UI, a chat bridge) needs.
 *
 * On connect the server first replays buffered events (from the newest snapshot, or after `?after=<epoch>:<seq>`
 * when that gap is still buffered), then streams live batches. Commands may be sent at any time; results carry the
 * client's `id` and may arrive in any order relative to events.
 *
 * A client that sends `ServeWorkspace` also serves the session's workspace: it receives `WorkspaceCall`s (and
 * `WorkspaceCancel`s) and answers each with `WorkspaceReply` events. The newest serving client wins.
 */

/** Client → server. */
export const ChannelRequest = Schema.Union([
  Schema.TaggedStruct("Command", { id: Schema.String, command: SessionCommand }),
  Schema.TaggedStruct("Ping", { id: Schema.String }),
  Schema.TaggedStruct("ServeWorkspace", {}),
  Schema.TaggedStruct("WorkspaceReply", { id: Schema.String, event: WorkspaceEvent })
])
export type ChannelRequest = typeof ChannelRequest.Type

/** Server → client. */
export const ChannelMessage = Schema.Union([
  Schema.TaggedStruct("Events", { batch: EventBatch }),
  Schema.TaggedStruct("Result", { id: Schema.String, result: CommandResult }),
  Schema.TaggedStruct("Pong", { id: Schema.String }),
  Schema.TaggedStruct("WorkspaceCall", { id: Schema.String, call: WorkspaceCall }),
  Schema.TaggedStruct("WorkspaceCancel", { id: Schema.String }),
  /** A request that could not be decoded, or a failure outside any command. */
  Schema.TaggedStruct("Error", { id: Schema.optional(Schema.String), message: Schema.String })
])
export type ChannelMessage = typeof ChannelMessage.Type

export const channelPath = (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}/channel`
