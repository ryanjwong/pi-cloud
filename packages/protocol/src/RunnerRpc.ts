import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { CommandResult, SessionCommand } from "./Commands.ts"
import { EventBatch, Session } from "./Domain.ts"
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

/** Ask the runner to start a fresh event stream, beginning with a snapshot. */
export const ResnapshotCommand = Schema.TaggedStruct("Resnapshot", {})

/**
 * A Chord service call from a presentation attached to the session (see `Services.ts`), relayed by the control
 * plane. Each attachment has its own endpoint on the runner; subscription updates come back over `ServiceUpdate`.
 * The reply is the call's result, or an error whose tag is a Chord error code.
 */
export const ServiceCallCommand = Schema.TaggedStruct("ServiceCall", {
  attachmentId: Schema.String,
  callId: Schema.String,
  call: Schema.Json
})

/** The presentation stopped waiting for a call. */
export const ServiceCancelCommand = Schema.TaggedStruct("ServiceCancel", { callId: Schema.String })

/** The attachment ended: drop its endpoint and subscriptions. */
export const ServiceReleaseCommand = Schema.TaggedStruct("ServiceRelease", { attachmentId: Schema.String })

/** Ask the runner to release its lease and stop, e.g. because the session was deleted. */
export const ShutdownCommand = Schema.TaggedStruct("Shutdown", { reason: Schema.String })

/** What runners execute: every client-facing `SessionCommand`, plus control-plane housekeeping. */
export const RunnerCommand = Schema.Union([
  ...SessionCommand.members,
  ResnapshotCommand,
  ServiceCallCommand,
  ServiceCancelCommand,
  ServiceReleaseCommand,
  ShutdownCommand
])
export type RunnerCommand = typeof RunnerCommand.Type

/** First message of an attachment: the lease and what the runner is hosting. */
export const LeaseGranted = Schema.TaggedStruct("LeaseGranted", {
  token: Schema.String,
  epoch: Schema.Number,
  ttlMs: Schema.Number,
  session: Session
})

export const RunnerMessage = Schema.Union([
  LeaseGranted,
  Schema.TaggedStruct("Command", { commandId: Schema.String, command: RunnerCommand })
])
export type RunnerMessage = typeof RunnerMessage.Type

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
  /** A Chord subscription update for one attachment's subscription. */
  Rpc.make("ServiceUpdate", {
    payload: { ...leaseFields, attachmentId: Schema.String, subscriptionId: Schema.String, update: Schema.Json },
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
