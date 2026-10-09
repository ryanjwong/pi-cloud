import { Schema } from "effect"
import { WorkspaceSpec } from "./Workspace.ts"

/** Identifies one session: one Pi Durable store, one lease, at most one live runner. */
export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

/** A pi-ai model reference, e.g. `{ provider: "anthropic", modelId: "claude-opus-5-5" }`. */
export const ModelRef = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String
})
export type ModelRef = typeof ModelRef.Type

/**
 * A recipe for a sandbox the agent may request. The control plane only stores it; the runner hands it to the
 * sandbox provider named by `provider`. Secrets are names, resolved on the runner, so their values never travel
 * through the control plane or land in the transcript.
 */
export const SandboxTemplate = Schema.Struct({
  provider: Schema.String,
  /**
   * A git repository cloned into the sandbox before `setup` runs. With `credential`, git authenticates with that
   * secret through a credential helper, so the token never appears in a command, a URL, or `.git/config`.
   */
  repository: Schema.optional(Schema.Struct({
    url: Schema.String,
    ref: Schema.optional(Schema.String),
    credential: Schema.optional(Schema.String)
  })),
  image: Schema.optional(Schema.String),
  /** Shell commands run once after the sandbox is created (and the repository cloned), e.g. installing tools. */
  setup: Schema.optional(Schema.Array(Schema.String)),
  /** Working directory inside the sandbox. */
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  secrets: Schema.optional(Schema.Array(Schema.String)),
  /** Provider-specific options. */
  options: Schema.optional(Schema.Record(Schema.String, Schema.Json))
})
export type SandboxTemplate = typeof SandboxTemplate.Type

/** Everything a runner needs to know to host a session. Stored by the control plane, delivered with the lease. */
export const SessionSpec = Schema.Struct({
  model: Schema.optional(ModelRef),
  thinkingLevel: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  /** Sandbox templates the agent may create, by name, in addition to those the runner defines. */
  sandboxes: Schema.optional(Schema.Record(Schema.String, SandboxTemplate)),
  /** The template the agent should work in; it is told to create that sandbox before doing anything else. */
  sandbox: Schema.optional(Schema.String),
  /**
   * Work on a client's machine instead of a sandbox: file and shell tools run in this directory on whichever client
   * serves the session's workspace (see `Workspace.ts`).
   */
  workspace: Schema.optional(WorkspaceSpec),
  /** Plugin configuration by plugin name; opaque to the control plane. */
  plugins: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  /** Free-form metadata for projections, e.g. the Slack thread a session belongs to. */
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

/** A session together with where it is running right now. */
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

/** Pi user content: a string or pi-ai content blocks. */
export const UserContent = Schema.Union([Schema.String, Schema.Array(Schema.Json)])
export type UserContent = typeof UserContent.Type

export const WhenBusy = Schema.Literals(["steer", "followUp", "reject"])
export type WhenBusy = typeof WhenBusy.Type

/** One batch of Pi `AgentEvent`s derived from one commit, tagged with where it sits in the session's stream. */
export const EventBatch = Schema.Struct({
  /** Changes whenever a new runner takes over; a client seeing a new epoch should expect a fresh snapshot. */
  epoch: Schema.Number,
  /** Increases by one per batch within an epoch. */
  seq: Schema.Number,
  conversationId: Schema.Number,
  events: Schema.Array(Schema.Json)
})
export type EventBatch = typeof EventBatch.Type
