import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { Effect } from "effect"
import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { SandboxError, type SandboxProvider } from "@pi-cloud/sandbox"

const safe = (key: string) => key.replace(/[^a-zA-Z0-9._-]/g, "_")

/**
 * Sandboxes as directories on the runner's machine. No isolation at all: for development, tests, and trusted
 * single-user setups. The same key always maps to the same directory, so creation is idempotent.
 */
export const localSandboxes = (options: { readonly root: string; readonly name?: string }): SandboxProvider => {
  const name = options.name ?? "local"
  const root = resolve(options.root)
  const failure = (cause: unknown) => new SandboxError({ message: cause instanceof Error ? cause.message : String(cause) })
  return {
    name,
    create: ({ key, template }) =>
      Effect.tryPromise({
        try: async () => {
          const dir = join(root, safe(key))
          const cwd = template.cwd === undefined ? dir : resolve(dir, template.cwd)
          await mkdir(cwd, { recursive: true })
          return { provider: name, id: safe(key), cwd, data: { dir } }
        },
        catch: failure
      }),
    connect: (handle, env) =>
      Effect.try({
        try: () => new NodeExecutionEnv({ cwd: handle.cwd, shellEnv: { ...process.env, ...env } }),
        catch: failure
      }),
    destroy: (handle) =>
      Effect.tryPromise({
        try: () => rm(join(root, handle.id), { recursive: true, force: true }),
        catch: failure
      })
  }
}
