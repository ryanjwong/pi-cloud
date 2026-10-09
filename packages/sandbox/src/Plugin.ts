import type { Context, JsonValue } from "@earendil-works/chord"
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

/**
 * Git configuration that authenticates HTTPS remotes with the `credential` secret through a credential helper.
 * The helper reads the variable when git asks, so the token is never written to a command line, a URL, or
 * `.git/config`. Works for GitHub tokens and any host that accepts a token as the password.
 */
export const gitCredentialEnv = (credential: string): Record<string, string> => ({
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: `!f() { test "$1" = get && echo username=x-access-token && echo "password=$${credential}"; }; f`
})

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

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
      const mask = new SecretMask()

      const provider = (name: string) => {
        const found = providers.get(name)
        if (found === undefined) throw new Error(`No sandbox provider named "${name}" is installed on this runner`)
        return found
      }

      /** Template env plus resolved secrets. Secrets are resolved on the runner and never stored. */
      const environment = async (template: SandboxTemplate) => {
        const env: Record<string, string> = { ...template.env }
        for (const name of new Set(template.secrets ?? [])) {
          const value = await plugin.secrets(name)
          if (value === undefined) throw new Error(`Secret ${name} is not available on this runner`)
          env[name] = value
          mask.add(name, value)
        }
        // A repository credential the runner does not have is skipped: public repositories clone without it.
        const credential = template.repository?.credential
        const token = credential === undefined ? undefined : await plugin.secrets(credential)
        if (credential !== undefined && token !== undefined) {
          env[credential] = token
          mask.add(credential, token)
          Object.assign(env, gitCredentialEnv(credential))
        }
        return env
      }

      const connect = (stored: StoredSandbox): Promise<ExecutionEnv> => {
        const key = `${stored.handle.provider}:${stored.handle.id}`
        let connection = connections.get(key)
        if (connection === undefined) {
          connection = (async () => {
            const template = templates[stored.template] ?? { provider: stored.handle.provider }
            const env = await environment(template)
            return mask.env(await Effect.runPromise(provider(stored.handle.provider).connect(stored.handle, env)))
          })()
          connection.catch(() => connections.delete(key))
          connections.set(key, connection)
        }
        return connection
      }

      /** Clone the template's repository and run its setup commands, streaming their output. */
      const setup = async (
        template: SandboxTemplate,
        stored: StoredSandbox,
        env: Record<string, string>,
        output: (chunk: string) => void,
        context: Context
      ) => {
        const shell = await connect(stored)
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
      }

      /**
       * The session's own sandbox (`spec.sandbox`), created the first time a tool needs an environment, so tools work
       * from the first turn as they do with a local Pi. Creation is keyed by session, so a restarted runner finds the
       * same sandbox; a marker file records that setup finished.
       */
      let preferred: Promise<ExecutionEnv> | undefined
      const preferredSandbox = (name: string, context: Context): Promise<ExecutionEnv> => {
        preferred ??= (async () => {
          const template = templates[name]
          if (template === undefined) throw new Error(`The session's sandbox template "${name}" does not exist`)
          const env = await environment(template)
          const handle = await Effect.runPromise(
            provider(template.provider).create({ key: `${plugin.session.id}/${name}`, template, env })
          )
          const stored: StoredSandbox = { template: name, handle }
          const shell = await connect(stored)
          const marker = template.repository === undefined ? ".pi-cloud-ready" : ".git/pi-cloud-ready"
          const ready = await shell.exec(`test -e ${marker}`, { cwd: handle.cwd }, context)
          if (!ready.ok || ready.value.exitCode !== 0) {
            await setup(template, stored, env, () => {}, context)
            await shell.exec(`touch ${marker}`, { cwd: handle.cwd }, context)
          }
          return shell
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
            await setup(template, stored, env, (chunk) => api.output(chunk), context)
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
          plugin.session.spec.workspace === undefined
            ? "File and shell tools only work inside a sandbox. Create one with sandbox_create when you need them."
            : "File and shell tools run in the developer's workspace. For isolated work, create a sandbox with " +
              "sandbox_create; tools then run in it until you destroy it.",
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
          // Whatever a tool returns (command output, file contents, ...) is masked before it is stored.
          hooks: [hook(ToolTask, {
            afterTool: (_call, result) =>
              mask.size === 0 ? undefined : { ...result, content: mask.deep(result.content), details: mask.deep(result.details) }
          })]
        })],
        env: async ({ read }, context) => {
          const state = await read.snapshot(SandboxesDoc, context)
          const active = state?.active === undefined ? undefined : state.sandboxes[state.active]
          if (active !== undefined) return connect(active)
          const own = plugin.session.spec.sandbox
          return own === undefined || plugin.session.spec.workspace !== undefined ? undefined : preferredSandbox(own, context)
        },
        dispose: async () => {
          const opened = [...connections.values()]
          connections.clear()
          await Promise.allSettled(opened.map(async (env) => (await env).cleanup(undefined as never)))
        }
      }
    }
  })
