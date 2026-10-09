import { Schema } from "effect"

/**
 * Workspaces: a client (the TUI, an editor) serves its own machine's files and shell to a session, so the agent
 * works on the developer's checkout exactly as Pi does locally, while the agent loop, model credentials and durable
 * state stay on the server.
 *
 * The runner calls Pi's `ExecutionEnv` methods; each call travels runner → control plane (`Workspace` RPC) →
 * client (the session channel) and streams back events. Values are JSON with a few tagged forms (bytes, errors,
 * handles for readers and watchers, callbacks such as `exec`'s `onOutput`); `@pi-cloud/workspace` encodes them.
 */

/** One `ExecutionEnv` method call, on the environment itself or on a handle it returned earlier (`target`). */
export const WorkspaceCall = Schema.Struct({
  method: Schema.String,
  target: Schema.optional(Schema.String),
  args: Schema.Array(Schema.Json)
})
export type WorkspaceCall = typeof WorkspaceCall.Type

/**
 * What a call streams back: callback invocations (output, file changes), then its outcome. The stream ends with
 * `End`, which for a watcher comes only once the watcher is closed.
 */
export const WorkspaceEvent = Schema.Union([
  Schema.TaggedStruct("Callback", { callback: Schema.Number, args: Schema.Array(Schema.Json) }),
  Schema.TaggedStruct("Done", { value: Schema.Json }),
  Schema.TaggedStruct("Failed", { message: Schema.String }),
  Schema.TaggedStruct("End", {})
])
export type WorkspaceEvent = typeof WorkspaceEvent.Type

/** Where a session's workspace lives: the client's directory the agent works in. */
export const WorkspaceSpec = Schema.Struct({
  cwd: Schema.String,
  /** Shown to the agent and in listings, e.g. the client's hostname. */
  host: Schema.optional(Schema.String),
  /** Pi's agent directory on the client (`~/.pi/agent`), whose `AGENTS.md` applies to every project. */
  agentDir: Schema.optional(Schema.String)
})
export type WorkspaceSpec = typeof WorkspaceSpec.Type
