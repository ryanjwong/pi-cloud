import type { Context } from "@earendil-works/chord"
import { Type } from "@earendil-works/pi-ai"
import { defineDoc, defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { SandboxTemplate } from "@pi-cloud/protocol"
import { definePlugin, type PluginContext, type RunnerPlugin } from "@pi-cloud/runner"
import { Effect } from "effect"
import { SecretMask } from "./Mask.ts"
import type { SandboxHandle, SandboxProvider } from "./Provider.ts"

type StoredSandbox = {
  readonly template: string
  readonly handle: SandboxHandle
}

export const gitCredentialEnv = (credential: string): Record<string, string> => ({
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: `!f() { test "$1" = get && echo username=x-access-token && echo "password=$${credential}"; }; f`
})

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export const SandboxesDoc = defineDoc<{ active?: string; sandboxes: Record<string, StoredSandbox> }>({
  kind: "pi-cloud.sandboxes",
  version: 1,
  scope: "session",
  initial: () => ({ sandboxes: {} })
})

export interface SandboxPluginOptions {
  readonly providers: ReadonlyArray<SandboxProvider>
  readonly templates?: Readonly<Record<string, SandboxTemplate>>
}

const text = (value: string) => [{ type: "text" as const, text: value }]

export const sandboxes = (options: SandboxPluginOptions): RunnerPlugin =>
  definePlugin({
    name: "sandboxes",
    setup: (plugin: PluginContext) => {
      const providers = new Map(options.providers.map((provider) => [provider.name, provider]))
      const templates: Record<string, SandboxTemplate> = { ...options.templates, ...plugin.session.spec.sandboxes }
      const connections = new Map<string, Promise<ExecutionEnv>>()
      const mask = new SecretMask()

      const provider = (name: string) => {
        const found = providers.get(name)
        if (found === undefined) throw new Error(`No sandbox provider named "${name}" is installed on this runner`)
        return found
      }

      const environment = async (template: SandboxTemplate) => {
        const env: Record<string, string> = { ...template.env }
        for (const name of new Set(template.secrets ?? [])) {
          const value = await plugin.secrets(name)
          if (value === undefined) throw new Error(`Secret ${name} is not available on this runner`)
          env[name] = value
          mask.add(name, value)
        }
        const credential = template.repository?.credential
        const token = credential === undefined ? undefined : await plugin.secrets(credential)
        if (credential !== undefined && token !== undefined) {
          env[credential] = token
          mask.add(credential, token)
          Object.assign(env, gitCredentialEnv(credential))
        }
        return env
      }

      const refreshing = (env: ExecutionEnv, credential: string | undefined): ExecutionEnv => {
        if (credential === undefined) return env
        const fresh = Object.create(env) as ExecutionEnv
        fresh.exec = async (command, options, context) => {
          const token = await plugin.secrets(credential)
          if (token === undefined) return env.exec(command, options, context)
          mask.add(credential, token)
          return env.exec(command, { ...options, env: { ...options?.env, [credential]: token } }, context)
        }
        return fresh
      }

      const connect = (stored: StoredSandbox): Promise<ExecutionEnv> => {
        const key = `${stored.handle.provider}:${stored.handle.id}`
        let connection = connections.get(key)
        if (connection === undefined) {
          connection = (async () => {
            const template = templates[stored.template] ?? { provider: stored.handle.provider }
            const env = await environment(template)
            const connected = mask.env(await Effect.runPromise(provider(stored.handle.provider).connect(stored.handle, env)))
            return refreshing(connected, template.repository?.credential)
          })()
          connection.catch(() => connections.delete(key))
          connections.set(key, connection)
        }
        return connection
      }

      const setup = async (
        template: SandboxTemplate,
        stored: StoredSandbox,
        env: Record<string, string>,
        output: (chunk: string) => void,
        context: Context
      ) => {
        const shell = await connect(stored)
        const marker = template.repository === undefined ? ".pi-cloud-ready" : ".git/pi-cloud-ready"
        const ready = await shell.exec(`test -e ${marker}`, { cwd: stored.handle.cwd }, context)
        if (ready.ok && ready.value.exitCode === 0) return
        const repository = template.repository
        const clone = repository === undefined
          ? []
          : [`git clone --quiet${repository.ref === undefined ? "" : ` --branch ${shellQuote(repository.ref)}`} ${shellQuote(repository.url)} .`]
        for (const command of [...clone, ...(template.setup ?? [])]) {
          output(`$ ${command}\n`)
          const result = await shell.exec(command, { cwd: stored.handle.cwd, env, onOutput: (chunk) => output(chunk) }, context)
          if (!result.ok) throw new Error(`Setup failed: ${String(result.error)}`)
          if (result.value.exitCode !== 0) throw new Error(`Setup command exited with ${result.value.exitCode}: ${command}`)
        }
        await shell.exec(`touch ${marker}`, { cwd: stored.handle.cwd }, context)
      }

      let preferred: Promise<{ stored: StoredSandbox; env: ExecutionEnv }> | undefined
      const preferredSandbox = (name: string, context: Context): Promise<{ stored: StoredSandbox; env: ExecutionEnv }> => {
        preferred ??= (async () => {
          const template = templates[name]
          if (template === undefined) throw new Error(`The session's sandbox template "${name}" does not exist`)
          const env = await environment(template)
          const handle = await Effect.runPromise(
            provider(template.provider).create({ key: `${plugin.session.id}/${name}`, template, env })
          )
          const stored: StoredSandbox = { template: name, handle }
          await setup(template, stored, env, () => {}, context)
          return { stored, env: await connect(stored) }
        })()
        preferred.catch(() => (preferred = undefined))
        return preferred
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
            return { output: text(`Sandbox "${name}" is active (working directory ${existing.handle.cwd}).`) }
          }
          if (args.template === plugin.session.spec.sandbox && name === args.template) {
            const { stored } = await preferredSandbox(name, context)
            await api.commit(async (tx) => {
              const doc = await tx.doc(SandboxesDoc)
              doc.sandboxes[name] = stored
              doc.active = name
            }, context)
            return { output: text(`Sandbox "${name}" is ready and active (working directory ${stored.handle.cwd}).`) }
          }
          const template = templates[args.template]
          if (template === undefined) {
            const known = Object.keys(templates)
            return {
              isError: true,
              output: text(`Unknown template "${args.template}". Available: ${known.length ? known.join(", ") : "none"}.`)
            }
          }
          const env = await environment(template)
          let handle = await api.memo<SandboxHandle>("handle", context)
          if (handle === undefined) {
            const created = await Effect.runPromise(
              provider(template.provider).create({ key: `${plugin.session.id}/${name}`, template, env })
            )
            handle = await api.memo("handle", created, context)
          }
          const stored: StoredSandbox = { template: args.template, handle }
          if ((await api.memo<boolean>("setup", context)) !== true) {
            await setup(template, stored, env, (chunk) => api.output(chunk), context)
            await api.memo("setup", true, context)
          }
          await api.commit(async (tx) => {
            const doc = await tx.doc(SandboxesDoc)
            doc.sandboxes[name] = stored
            doc.active = name
          }, context)
          return { output: text(`Sandbox "${name}" is ready and active (working directory ${handle.cwd}).`) }
        }
      })

      const destroy = defineTool({
        name: "sandbox_destroy",
        description: "Destroy a sandbox you no longer need.",
        parameters: Type.Object({ name: Type.String() }),
        replay: "safe",
        async execute(args, api, context) {
          const stored = (await api.snapshot(SandboxesDoc, context))?.sandboxes[args.name]
          if (stored === undefined) return { output: text(`No sandbox named "${args.name}".`) }
          await Effect.runPromise(provider(stored.handle.provider).destroy(stored.handle))
          connections.delete(`${stored.handle.provider}:${stored.handle.id}`)
          await api.commit(async (tx) => {
            const doc = await tx.doc(SandboxesDoc)
            delete doc.sandboxes[args.name]
            if (doc.active === args.name) delete doc.active
          }, context)
          return { output: text(`Sandbox "${args.name}" destroyed.`) }
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
        const own = plugin.session.spec.sandbox
        if (state?.active === undefined && own !== undefined) {
          lines[0] = `File and shell tools run in this session's "${own}" sandbox, which is set up for you.`
        }
        return lines.join("\n")
      })

      return {
        extensions: [defineExtension({
          name: "pi-cloud-sandboxes",
          tools: [create, destroy],
          sections: [guide],
          hooks: [hook(ToolTask, {
            afterTool: (_call, result) =>
              mask.size === 0 ? undefined : mask.deep(result)
          })]
        })],
        env: async ({ read }, context) => {
          const state = await read.snapshot(SandboxesDoc, context)
          const active = state?.active === undefined ? undefined : state.sandboxes[state.active]
          if (active !== undefined) return connect(active)
          const own = plugin.session.spec.sandbox
          return own === undefined ? undefined : (await preferredSandbox(own, context)).env
        },
        dispose: async () => {
          const opened = [...connections.values()]
          connections.clear()
          await Promise.allSettled(opened.map(async (env) => (await env).cleanup(undefined as never)))
        }
      }
    }
  })
