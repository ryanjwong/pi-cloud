import { Schema } from "effect"

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  { sessionId: Schema.String },
  { httpApiStatus: 404 }
) {}

/** No runner attached in time to take the request. */
export class RunnerUnavailable extends Schema.TaggedError<RunnerUnavailable>()(
  "RunnerUnavailable",
  { sessionId: Schema.String, message: Schema.String },
  { httpApiStatus: 503 }
) {}

/** The session's conversation is busy and the submission asked to be rejected in that case. */
export class ConversationBusy extends Schema.TaggedError<ConversationBusy>()(
  "ConversationBusy",
  { sessionId: Schema.String },
  { httpApiStatus: 409 }
) {}

/** No client is serving the session's workspace, or it went away during a call. */
export class WorkspaceUnavailable extends Schema.TaggedError<WorkspaceUnavailable>()(
  "WorkspaceUnavailable",
  { sessionId: Schema.String, message: Schema.String },
  { httpApiStatus: 503 }
) {}

/** The runner rejected or failed a command. */
export class CommandFailed extends Schema.TaggedError<CommandFailed>()(
  "CommandFailed",
  { message: Schema.String, reason: Schema.optional(Schema.String) },
  { httpApiStatus: 500 }
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 }
) {}

/** Another runner holds the session's lease. */
export class LeaseHeld extends Schema.TaggedError<LeaseHeld>()("LeaseHeld", {
  sessionId: Schema.String,
  holder: Schema.String
}) {}

/** The caller's lease expired or was replaced; it must stop writing at once. */
export class LeaseLost extends Schema.TaggedError<LeaseLost>()("LeaseLost", {
  sessionId: Schema.String
}) {}

/** The storage backend rejected an operation. */
export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  message: Schema.String
}) {}
