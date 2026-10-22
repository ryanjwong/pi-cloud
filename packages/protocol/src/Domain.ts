import { Schema } from "effect"

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export const ModelRef = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String
})
export type ModelRef = typeof ModelRef.Type

export const SandboxTemplate = Schema.Struct({
  provider: Schema.String,
  repository: Schema.optional(Schema.Struct({
    url: Schema.String,
    ref: Schema.optional(Schema.String),
    credential: Schema.optional(Schema.String)
  })),
  image: Schema.optional(Schema.String),
  setup: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  secrets: Schema.optional(Schema.Array(Schema.String)),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Json))
})
export type SandboxTemplate = typeof SandboxTemplate.Type

export const SessionSpec = Schema.Struct({
  model: Schema.optional(ModelRef),
  thinkingLevel: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  sandboxes: Schema.optional(Schema.Record(Schema.String, SandboxTemplate)),
  sandbox: Schema.optional(Schema.String),
  plugins: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json))
})
export type SessionSpec = typeof SessionSpec.Type

export class Session extends Schema.Class<Session>("@pi-cloud/protocol/Session")({
  id: SessionId,
  title: Schema.optional(Schema.String),
  spec: SessionSpec,
  createdAt: Schema.Number
}) {}

export const RunnerState = Schema.Literals(["idle", "starting", "running"])
export type RunnerState = typeof RunnerState.Type

export const SessionView = Schema.Struct({
  id: SessionId,
  title: Schema.optional(Schema.String),
  spec: SessionSpec,
  createdAt: Schema.Number,
  runner: Schema.Struct({
    state: RunnerState,
    runnerId: Schema.optional(Schema.String),
    leaseExpiresAt: Schema.optional(Schema.Number)
  })
})
export type SessionView = typeof SessionView.Type

export const UserContent = Schema.Union([Schema.String, Schema.Array(Schema.Json)])
export type UserContent = typeof UserContent.Type

export const WhenBusy = Schema.Literals(["steer", "followUp", "reject"])
export type WhenBusy = typeof WhenBusy.Type

export const EventBatch = Schema.Struct({
  epoch: Schema.Number,
  seq: Schema.Number,
  conversationId: Schema.Number,
  events: Schema.Array(Schema.Json)
})
export type EventBatch = typeof EventBatch.Type
