import { Schema } from "effect"

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()(
  "SessionNotFound",
  { sessionId: Schema.String },
  { httpApiStatus: 404 }
) {}

export class RunnerUnavailable extends Schema.TaggedError<RunnerUnavailable>()(
  "RunnerUnavailable",
  { sessionId: Schema.String, message: Schema.String },
  { httpApiStatus: 503 }
) {}

export class ConversationBusy extends Schema.TaggedError<ConversationBusy>()(
  "ConversationBusy",
  { sessionId: Schema.String },
  { httpApiStatus: 409 }
) {}

export class SpecRejected extends Schema.TaggedError<SpecRejected>()(
  "SpecRejected",
  { field: Schema.String, reason: Schema.String },
  { httpApiStatus: 400 }
) {
  override get message() {
    return `${this.field}: ${this.reason}`
  }
}

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

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 }
) {}

export class LeaseHeld extends Schema.TaggedError<LeaseHeld>()("LeaseHeld", {
  sessionId: Schema.String,
  holder: Schema.String
}) {}

export class LeaseLost extends Schema.TaggedError<LeaseLost>()("LeaseLost", {
  sessionId: Schema.String
}) {}

export class StorageFailure extends Schema.TaggedError<StorageFailure>()(
  "StorageFailure",
  { message: Schema.String, request: Schema.optional(Schema.Boolean) },
  { httpApiStatus: 500 }
) {}
