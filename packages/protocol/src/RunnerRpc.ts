import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { EventBatch, Session, UserContent, WhenBusy } from "./Domain.ts"
import { LeaseHeld, LeaseLost, SessionNotFound, StorageFailure } from "./Errors.ts"

/**
 * The internal protocol between the control plane and runners.
 *
 * Runners only ever dial out: they attach to receive a lease and a stream of commands, and call back to read and
 * write durable state, renew their lease, reply to commands, and publish events. A runner therefore needs nothing
 * from its substrate except outbound HTTP, so it can live in a Durable Object, a container, a Modal function, or a
 * plain process.
 */

/** Pi Durable `Storage` methods a runner may call through the control plane. */
export const StorageMethod = Schema.Literals([
  "commit",
  "mintId",
  "conversation",
  "scanConversations",
  "entry",
  "findLatestHeadMarker",
  "scanEntries",
  "task",
  "scanTasks",
  "submission",
  "scanSubmissions",
  "submissionByRequest",
  "findDocument",
  "document",
  "scanDocuments"
])
export type StorageMethod = typeof StorageMethod.Type

const leaseFields = {
  sessionId: Schema.String,
  /** The fencing token issued with the lease. Every write carries it. */
  token: Schema.String
}

export const SubmitCommand = Schema.TaggedStruct("Submit", {
  commandId: Schema.String,
  conversationId: Schema.optional(Schema.Number),
  content: UserContent,
  requestId: Schema.optional(Schema.String),
  whenBusy: Schema.optional(WhenBusy)
})

export const AbortCommand = Schema.TaggedStruct("Abort", {
  commandId: Schema.String,
  conversationId: Schema.optional(Schema.Number)
})

/** Ask the runner to start a fresh event stream, beginning with a snapshot. */
export const ResnapshotCommand = Schema.TaggedStruct("Resnapshot", {
  commandId: Schema.String
})

/** Ask the runner to release its lease and stop, e.g. because the session was deleted. */
export const ShutdownCommand = Schema.TaggedStruct("Shutdown", {
  commandId: Schema.String,
  reason: Schema.String
})

/** Extension point: commands a plugin understands. Runners reply with an error to unknown names. */
export const CustomCommand = Schema.TaggedStruct("Custom", {
  commandId: Schema.String,
  name: Schema.String,
  payload: Schema.Json
})

export const RunnerCommand = Schema.Union([
  SubmitCommand,
  AbortCommand,
  ResnapshotCommand,
  ShutdownCommand,
  CustomCommand
])
export type RunnerCommand = typeof RunnerCommand.Type

/** First message of an attachment: the lease and what the runner is hosting. */
export const LeaseGranted = Schema.TaggedStruct("LeaseGranted", {
  token: Schema.String,
  epoch: Schema.Number,
  ttlMs: Schema.Number,
  session: Session
})

export const RunnerMessage = Schema.Union([LeaseGranted, Schema.TaggedStruct("Command", { command: RunnerCommand })])
export type RunnerMessage = typeof RunnerMessage.Type

export const CommandResult = Schema.Union([
  Schema.TaggedStruct("Ok", { value: Schema.optional(Schema.Json) }),
  Schema.TaggedStruct("Err", { tag: Schema.String, message: Schema.String })
])
export type CommandResult = typeof CommandResult.Type

export class RunnerRpcs extends RpcGroup.make(
  /**
   * Take the session's lease (or re-bind to it after a dropped connection, by passing the current token) and
   * receive commands until the stream ends.
   */
  Rpc.make("Attach", {
    payload: {
      sessionId: Schema.String,
      runnerId: Schema.String,
      token: Schema.optional(Schema.String)
    },
    success: RunnerMessage,
    error: Schema.Union([LeaseHeld, SessionNotFound]),
    stream: true
  }),
  Rpc.make("Renew", {
    payload: leaseFields,
    success: Schema.Struct({ expiresAt: Schema.Number }),
    error: LeaseLost
  }),
  Rpc.make("Release", { payload: leaseFields }),
  Rpc.make("Reply", {
    payload: { ...leaseFields, commandId: Schema.String, result: CommandResult },
    error: LeaseLost
  }),
  Rpc.make("Publish", {
    payload: { ...leaseFields, batches: Schema.Array(EventBatch) },
    error: LeaseLost
  }),
  /**
   * One Pi Durable `Storage` call. Arguments and results are JSON; `undefined` arguments travel as `null`.
   * `commit` is fenced: it fails with `LeaseLost` unless `token` holds the lease at the moment it is applied.
   */
  Rpc.make("Storage", {
    payload: { ...leaseFields, method: StorageMethod, args: Schema.Array(Schema.Json) },
    success: Schema.Struct({ value: Schema.optional(Schema.Json) }),
    error: Schema.Union([LeaseLost, StorageFailure])
  })
) {}

/** Path the control plane serves `RunnerRpcs` on. */
export const RUNNER_RPC_PATH = "/internal/runner"

/**
 * Body of the wake-up call a dispatcher sends to a runner host. The host starts a runner for `sessionId` that
 * attaches to `controlPlaneUrl`. Any substrate that can receive this one HTTP request can host runners.
 */
export const WakeRequest = Schema.Struct({
  sessionId: Schema.String,
  controlPlaneUrl: Schema.String
})
export type WakeRequest = typeof WakeRequest.Type
