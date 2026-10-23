import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { CommandResult, SessionCommand } from "./Commands.ts"
import { StoredCredential } from "./Credentials.ts"
import { EventBatch, Session } from "./Domain.ts"
import { LeaseHeld, LeaseLost, SessionNotFound, StorageFailure, Unauthorized } from "./Errors.ts"

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

export const DumpValue = Schema.Union([Schema.Null, Schema.Number, Schema.String, Schema.Struct({ base64: Schema.String })])

export const StorageDump = Schema.Struct({
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
  token: Schema.String
}

export const ResnapshotCommand = Schema.TaggedStruct("Resnapshot", {})

export const ShutdownCommand = Schema.TaggedStruct("Shutdown", { reason: Schema.String })

export const RunnerCommand = Schema.Union([
  ...SessionCommand.members,
  ResnapshotCommand,
  ShutdownCommand
])
export type RunnerCommand = typeof RunnerCommand.Type

export const LeaseGranted = Schema.TaggedStruct("LeaseGranted", {
  token: Schema.String,
  epoch: Schema.Number,
  ttlMs: Schema.Number,
  session: Session
})

export const ChordFrames = Schema.TaggedStruct("Frames", { link: Schema.Number, frames: Schema.Array(Schema.Json) })

export const RunnerMessage = Schema.Union([
  LeaseGranted,
  Schema.TaggedStruct("Command", { commandId: Schema.String, command: RunnerCommand }),
  ChordFrames
])
export type RunnerMessage = typeof RunnerMessage.Type

export class RunnerRpcs extends RpcGroup.make(
  Rpc.make("Attach", {
    payload: {
      sessionId: Schema.String,
      runnerId: Schema.String,
      grant: Schema.String,
      token: Schema.optional(Schema.String)
    },
    success: RunnerMessage,
    error: Schema.Union([LeaseHeld, SessionNotFound, Unauthorized]),
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
  Rpc.make("CredentialGet", {
    payload: { ...leaseFields, providerId: Schema.String },
    success: Schema.Struct({ credential: Schema.optional(StoredCredential), version: Schema.Number }),
    error: Schema.Union([LeaseLost, StorageFailure])
  }),
  Rpc.make("CredentialList", {
    payload: leaseFields,
    success: Schema.Array(Schema.Struct({ providerId: Schema.String, type: Schema.Literals(["api_key", "oauth"]) })),
    error: Schema.Union([LeaseLost, StorageFailure])
  }),
  Rpc.make("CredentialPut", {
    payload: { ...leaseFields, providerId: Schema.String, version: Schema.Number, credential: StoredCredential },
    success: Schema.Struct({ stored: Schema.Boolean, version: Schema.Number }),
    error: Schema.Union([LeaseLost, StorageFailure])
  }),
  Rpc.make("SessionSecret", {
    payload: { ...leaseFields, name: Schema.String },
    success: Schema.Struct({ value: Schema.optional(Schema.String), expiresAt: Schema.optional(Schema.Number) }),
    error: Schema.Union([LeaseLost, StorageFailure])
  }),
  Rpc.make("StorageDump", {
    payload: leaseFields,
    success: Schema.Struct({ dump: Schema.optional(StorageDump) }),
    error: Schema.Union([LeaseLost, StorageFailure])
  }),
  Rpc.make("Frames", {
    payload: { ...leaseFields, link: Schema.Number, frames: Schema.Array(Schema.Json) },
    error: LeaseLost
  }),
  Rpc.make("Storage", {
    payload: { ...leaseFields, method: StorageMethod, args: Schema.Array(Schema.Json), requestId: Schema.optional(Schema.String) },
    success: Schema.Struct({ value: Schema.optional(Schema.Json) }),
    error: Schema.Union([LeaseLost, StorageFailure])
  })
) {}

export const RUNNER_RPC_PATH = "/internal/runner"
export const RUNNER_WAKE_PATH = "/internal/runner/wake"

export const WakeRequest = Schema.Struct({
  sessionId: Schema.String,
  controlPlaneUrl: Schema.String,
  grant: Schema.String
})
export type WakeRequest = typeof WakeRequest.Type
