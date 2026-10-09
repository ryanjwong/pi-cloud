import type { JsonValue } from "@earendil-works/chord"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { SandboxTemplate } from "@pi-cloud/protocol"
import { type Effect, Schema } from "effect"

/**
 * A durable reference to a sandbox. It is stored in the session's state, so it must be plain JSON and enough for
 * the provider to reconnect after the runner restarts somewhere else.
 */
export type SandboxHandle = {
  readonly provider: string
  readonly id: string
  /** Working directory inside the sandbox. */
  readonly cwd: string
  /** Provider-specific reconnection data. */
  readonly data?: JsonValue
}

export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  message: Schema.String
}) {}

export interface CreateSandbox {
  /**
   * Idempotency key: creating twice with the same key must yield the same sandbox, so a create that was cut off
   * by a crash can safely be retried.
   */
  readonly key: string
  readonly template: SandboxTemplate
  /** Environment for every command in the sandbox: the template's `env` plus resolved secrets. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * A sandbox substrate: local directories, containers, Modal, Cloudflare Sandbox, ... Implement these three
 * operations and the sandbox tools, the setup scripts, and every Pi coding tool work on it.
 */
export interface SandboxProvider {
  readonly name: string
  create(request: CreateSandbox): Effect.Effect<SandboxHandle, SandboxError>
  /** An execution environment for Pi's tools. Called again after every runner restart. */
  connect(handle: SandboxHandle, env: Readonly<Record<string, string>>): Effect.Effect<ExecutionEnv, SandboxError>
  destroy(handle: SandboxHandle): Effect.Effect<void, SandboxError>
}
