import type { JsonValue } from "@earendil-works/chord"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { SandboxTemplate } from "@pi-cloud/protocol"
import { type Effect, Schema } from "effect"

export type SandboxHandle = {
  readonly provider: string
  readonly id: string
  readonly cwd: string
  readonly data?: JsonValue
}

export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", {
  message: Schema.String
}) {}

export interface CreateSandbox {
  readonly key: string
  readonly template: SandboxTemplate
  readonly env: Readonly<Record<string, string>>
}

export interface SandboxProvider {
  readonly name: string
  create(request: CreateSandbox): Effect.Effect<SandboxHandle, SandboxError>
  connect(handle: SandboxHandle, env: Readonly<Record<string, string>>): Effect.Effect<ExecutionEnv, SandboxError>
  destroy(handle: SandboxHandle): Effect.Effect<void, SandboxError>
}
