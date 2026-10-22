import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { SandboxError, type SandboxProvider } from "@pi-cloud/sandbox"
import { Effect } from "effect"
import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

const safe = (key: string) => key.replace(/[^a-zA-Z0-9._-]/g, "_")

const BASE_VARIABLES = ["PATH", "LANG", "LC_ALL", "TZ", "TERM"] as const

export const isolate = (env: ExecutionEnv, variables: Readonly<Record<string, string>>): ExecutionEnv => {
  const isolated = Object.create(env) as ExecutionEnv
  isolated.exec = (command, options, context) =>
    env.exec(command, { ...options, inheritEnv: false, env: { ...variables, ...options?.env } }, context)
  return isolated
}

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
        try: () => {
          const base: Record<string, string> = { HOME: join(root, handle.id), SHELL: "/bin/sh" }
          for (const variable of BASE_VARIABLES) {
            const value = process.env[variable]
            if (value !== undefined) base[variable] = value
          }
          return isolate(new NodeExecutionEnv({ cwd: handle.cwd }), { ...base, ...env })
        },
        catch: failure
      }),
    destroy: (handle) =>
      Effect.tryPromise({
        try: () => rm(join(root, handle.id), { recursive: true, force: true }),
        catch: failure
      })
  }
}
