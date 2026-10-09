import type { Context, JsonValue } from "@earendil-works/chord"
import { Type } from "@earendil-works/pi-ai"
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { SandboxTemplate } from "@pi-cloud/protocol"
import { definePlugin, type PluginContext, type RunnerPlugin } from "@pi-cloud/runner"
import { Effect } from "effect"
import type { SandboxHandle, SandboxProvider } from "./Provider.ts"

type StoredSandbox = {
  readonly template: string
  readonly handle: SandboxHandle
}

/** The session's sandboxes, by name, and which one tools run in. Session-scoped, so subagents share it. */
export const SandboxesDoc = defineDoc<{ active?: string; sandboxes: Record<string, StoredSandbox> }>({
  kind: "pi-cloud.sandboxes",
  version: 1,
  scope: "session",
  initial: () => ({ sandboxes: {} })
})

export interface SandboxPluginOptions {
  readonly providers: ReadonlyArray<SandboxProvider>
  /** Templates available to every session, merged under the session spec's own `sandboxes`. */
  readonly templates?: Readonly<Record<string, SandboxTemplate>>
}

const text = (value: string) => [{ type: "text" as const, text: value }]

/**
 * Lets the agent request sandboxes on demand. The session spec names templates (provider, setup script, env,
 * secret names); the agent creates one with `sandbox_create`, and from then on Pi's coding tools (`bash`, `read`,
 * `write`, `edit`, ...) run inside it. Handles live in the session's durable state, so a runner restarted
 * elsewhere reconnects to the same sandbox.
 */
export const sandboxes = (options: SandboxPluginOptions): RunnerPlugin =>
  definePlugin({
    name: "sandboxes",
    setup: (plugin: PluginContext) => {
      const providers = new Map(options.providers.map((provider) => [provider.name, provider]))
      const templates: Record<string, SandboxTemplate> = { ...options.templates, ...plugin.session.spec.sandboxes }
      const connections = new Map<string, Promise<ExecutionEnv>>()

      const provider = (name: string) => {
        const found = providers.get(name)
        if (found === undefined) throw new Error(`No sandbox provider named "${name}" is installed on this runner`)
        return found
      }

      /** Template env plus resolved secrets. Secrets are resolved on the runner and never stored. */
      const environment = async (template: SandboxTemplate) => {
        const env: Record<string, string> = { ...template.env }
        for (const name of template.secrets ?? []) {
          const value = await plugin.secrets(name)
          if (value === undefined) throw new Error(`Secret ${name} is not available on this runner`)
          env[name] = value
        }
        return env
      }

      const connect = (stored: StoredSandbox): Promise<ExecutionEnv> => {
        const key = `${stored.handle.provider}:${stored.handle.id}`
        let connection = connections.get(key)
        if (connection === undefined) {
          connection = (async () => {
            const template = templates[stored.template] ?? { provider: stored.handle.provider }
            return Effect.runPromise(provider(stored.handle.provider).connect(stored.handle, await environment(template)))
          })()
          connection.catch(() => connections.delete(key))
          connections.set(key, connection)
        }
        return connection
      }

      const create = defineTool({
        name: "sandbox_create",
        description: "Create a sandbox from one of the session's templates and make it the active one. " +
          "Its setup script runs once (for example cloning a repository). Afterwards bash, read, write and edit " +
          "run inside the active sandbox. Creating a name that already exists just activates it.",
        parameters: Type.Object({
          template: Type.String({ description: "Template name" }),
          name: Type.Optional(Type.String({ description: "Name for the sandbox; defaults to the template name" }))
        }),
        replay: "safe",
        async execute(args, api, context) {
          const name = args.name ?? args.template
          const existing = (await api.snapshot(SandboxesDoc, context))?.sandboxes[name]
          if (existing !== undefined) {
            await api.commit(async (tx) => void ((await tx.doc(SandboxesDoc)).active = name), context)
            return { content: text(`Sandbox "${name}" is active (working directory ${existing.handle.cwd}).`) }
          }
          const template = templates[args.template]
          if (template === undefined) {
            const known = Object.keys(templates)
            return {
              isError: true,
              content: text(`Unknown template "${args.template}". Available: ${known.length ? known.join(", ") : "none"}.`)
            }
          }
          const env = await environment(template)
          // Memoized so a retry after a crash reconnects to the same sandbox rather than creating another.
          let handle = await api.memo<SandboxHandle>("handle", context)
          if (handle === undefined) {
            const created = await Effect.runPromise(
              provider(template.provider).create({ key: `${plugin.session.id}/${name}`, template, env })
            )
            handle = await api.memo("handle", created, context)
          }
          const stored: StoredSandbox = { template: args.template, handle }
          if ((await api.memo<boolean>("setup", context)) !== true) {
            const shell = await connect(stored)
            for (const command of template.setup ?? []) {
              api.output(`$ ${command}\n`)
              const result = await shell.exec(command, {
                cwd: handle.cwd,
                env,
                onOutput: (chunk) => api.output(chunk)
              }, context)
              if (!result.ok) throw new Error(`Setup failed: ${String(result.error)}`)
              if (result.value.exitCode !== 0) {
                throw new Error(`Setup command exited with ${result.value.exitCode}: ${command}`)
              }
            }
            await api.memo("setup", true, context)
          }
          await api.commit(async (tx) => {
            const doc = await tx.doc(SandboxesDoc)
            doc.sandboxes[name] = stored
            doc.active = name
          }, context)
          return { content: text(`Sandbox "${name}" is ready and active (working directory ${handle.cwd}).`) }
        }
      })

      const destroy = defineTool({
        name: "sandbox_destroy",
        description: "Destroy a sandbox you no longer need.",
        parameters: Type.Object({ name: Type.String() }),
        replay: "safe",
        async execute(args, api, context) {
          const stored = (await api.snapshot(SandboxesDoc, context))?.sandboxes[args.name]
          if (stored === undefined) return { content: text(`No sandbox named "${args.name}".`) }
          await Effect.runPromise(provider(stored.handle.provider).destroy(stored.handle))
          connections.delete(`${stored.handle.provider}:${stored.handle.id}`)
          await api.commit(async (tx) => {
            const doc = await tx.doc(SandboxesDoc)
            delete doc.sandboxes[args.name]
            if (doc.active === args.name) delete doc.active
          }, context)
          return { content: text(`Sandbox "${args.name}" destroyed.`) }
        }
      })

      const guide = section("sandboxes", async ({ read }, context: Context) => {
        const names = Object.keys(templates)
        if (names.length === 0) return undefined
        const state = await read.snapshot(SandboxesDoc, context)
        const lines = [
          "File and shell tools only work inside a sandbox. Create one with sandbox_create when you need them.",
          `Templates: ${names.map((name) => `${name} (${templates[name]!.provider})`).join(", ")}.`
        ]
        if (state?.active !== undefined) lines.push(`Active sandbox: ${state.active}.`)
        return lines.join("\n")
      })

      return {
        extensions: [defineExtension({ name: "pi-cloud-sandboxes", tools: [create, destroy], sections: [guide] })],
        env: async ({ read }, context) => {
          const state = await read.snapshot(SandboxesDoc, context)
          const active = state?.active === undefined ? undefined : state.sandboxes[state.active]
          return active === undefined ? undefined : connect(active)
        },
        dispose: async () => {
          const opened = [...connections.values()]
          connections.clear()
          await Promise.allSettled(opened.map(async (env) => (await env).cleanup(undefined as never)))
        }
      }
    }
  })
