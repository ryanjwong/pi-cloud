import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { CommandResult, SessionCommand } from "./Commands.ts"
import { StoredCredential } from "./Credentials.ts"
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

/** A SQLite value in a dump: blobs travel as base64. */
export const DumpValue = Schema.Union([Schema.Null, Schema.Number, Schema.String, Schema.Struct({ base64: Schema.String })])

/**
 * A session's Pi Durable SQLite tables, as one consistent copy: the schema statements, then every row. A runner
 * loads it into a local database and reads from there (see `ReplicatedStorage`).
 */
export const StorageDump = Schema.Struct({
  /** The prefix of the session's tables (Pi's `SqliteStorage` option), when they share a database. */
  prefix: Schema.optional(Schema.String),
  schema: Schema.Array(Schema.String),
  tables: Schema.Array(Schema.Struct({
    name: Schema.String,
    columns: Schema.Array(Schema.String),
    rows: Schema.Array(Schema.Array(DumpValue))
  }))
})
export type StorageDump = typeof StorageDump.Type

const leaseFields = {
  sessionId: Schema.String,
  /** The fencing token issued with the lease. Every write carries it. */
  token: Schema.String
}

/** Ask the runner to start a fresh event stream, beginning with a snapshot. */
export const ResnapshotCommand = Schema.TaggedStruct("Resnapshot", {})

/** Ask the runner to release its lease and stop, e.g. because the session was deleted. */
export const ShutdownCommand = Schema.TaggedStruct("Shutdown", { reason: Schema.String })

/** What runners execute: every client-facing `SessionCommand`, plus control-plane housekeeping. */
export const RunnerCommand = Schema.Union([
  ...SessionCommand.members,
  ResnapshotCommand,
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

/**
 * Chord frames from the control plane's host to the session's host (see `Services.ts`). `link` numbers the link
 * within the lease: a new number means the control plane opened a new link, and the old one is gone.
 */
export const ChordFrames = Schema.TaggedStruct("Frames", { link: Schema.Number, frames: Schema.Array(Schema.Json) })

export const RunnerMessage = Schema.Union([
  LeaseGranted,
  Schema.TaggedStruct("Command", { commandId: Schema.String, command: RunnerCommand }),
  ChordFrames
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
  /**
   * A stored model credential, with its version for `CredentialPut`. Runners read credentials through the control
   * plane, so every runner uses (and refreshes) the same subscription login.
   */
  Rpc.make("CredentialGet", {
    payload: { ...leaseFields, providerId: Schema.String },
    success: Schema.Struct({ credential: Schema.optional(StoredCredential), version: Schema.Number }),
    error: LeaseLost
  }),
  Rpc.make("CredentialList", {
    payload: leaseFields,
    success: Schema.Array(Schema.Struct({ providerId: Schema.String, type: Schema.Literals(["api_key", "oauth"]) })),
    error: LeaseLost
  }),
  /**
   * Replace a credential if it is still at `version` (a refreshed OAuth token, typically). Concurrent refreshes from
   * several runners cannot lose one another's tokens: the loser reads the winner's and uses it.
   */
  Rpc.make("CredentialPut", {
    payload: { ...leaseFields, providerId: Schema.String, version: Schema.Number, credential: StoredCredential },
    success: Schema.Struct({ stored: Schema.Boolean, version: Schema.Number }),
    error: LeaseLost
  }),
  /**
   * A secret the control plane issues to this session, such as a GitHub App installation token scoped to the
   * session's repository. Absent when the control plane has none by that name for this session; the runner then
   * falls back to its own. `expiresAt` (epoch ms) says when to ask again.
   */
  Rpc.make("SessionSecret", {
    payload: { ...leaseFields, name: Schema.String },
    success: Schema.Struct({ value: Schema.optional(Schema.String), expiresAt: Schema.optional(Schema.Number) }),
    error: Schema.Union([LeaseLost, StorageFailure])
  }),
  /**
   * A consistent copy of the session's storage, taken between commits, when the state store keeps it in SQLite.
   * Absent otherwise: the runner then reads through `Storage`.
   */
  Rpc.make("StorageDump", {
    payload: leaseFields,
    success: Schema.Struct({ dump: Schema.optional(StorageDump) }),
    error: Schema.Union([LeaseLost, StorageFailure])
  }),
  /** Chord frames from the session's host to the control plane's, on the link numbered `link`. */
  Rpc.make("Frames", {
    payload: { ...leaseFields, link: Schema.Number, frames: Schema.Array(Schema.Json) },
    error: LeaseLost
  }),
  /**
   * One Pi Durable `Storage` call. Arguments and results are JSON; `undefined` arguments travel as `null`.
   * `commit` is fenced: it fails with `LeaseLost` unless `token` holds the lease at the moment it is applied. A
   * commit carries a `requestId`, so one retried after a lost response applies once.
   */
  Rpc.make("Storage", {
    payload: { ...leaseFields, method: StorageMethod, args: Schema.Array(Schema.Json), requestId: Schema.optional(Schema.String) },
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
