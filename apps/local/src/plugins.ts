import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import type { RunnerEnv } from "@pi-cloud/config"
import { SandboxTemplate } from "@pi-cloud/protocol"
import { extensions, modelProviders, type RunnerPlugin } from "@pi-cloud/runner"
import { sandboxes } from "@pi-cloud/sandbox"
import { localSandboxes } from "@pi-cloud/sandbox-local"
import { githubTools } from "@pi-cloud/tool-github"
import { workspace } from "@pi-cloud/workspace/plugin"
import { Option, Redacted, Schema } from "effect"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const decodeTemplates = Schema.decodeUnknownSync(Schema.Record(Schema.String, SandboxTemplate))

/** Sandbox templates every session may use: `scratch`, plus those in `SANDBOX_TEMPLATES_FILE`. */
export const loadTemplates = (file: string | undefined): Record<string, SandboxTemplate> => {
  const templates: Record<string, SandboxTemplate> = { scratch: { provider: "local" } }
  if (file === undefined) return templates
  try {
    return { ...templates, ...decodeTemplates(JSON.parse(readFileSync(file, "utf8"))) }
  } catch (error) {
    throw new Error(`SANDBOX_TEMPLATES_FILE ${file} is not a valid template file: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * The plugin set of a Node runner: Anthropic and OpenAI models, Pi's coding tools, client workspaces (the TUI's
 * checkout), local sandboxes with the configured templates, and GitHub tools when `GITHUB_TOKEN` is set. Swap or
 * extend freely.
 */
export const defaultPlugins = (env: RunnerEnv): ReadonlyArray<RunnerPlugin> => {
  const plugins: Array<RunnerPlugin> = [
    modelProviders(anthropicProvider, openaiProvider),
    extensions("coding", CodingTools),
    sandboxes({
      providers: [localSandboxes({ root: join(resolve(env.dataDir), "sandboxes") })],
      templates: loadTemplates(Option.getOrUndefined(env.templatesFile))
    }),
    workspace()
  ]
  if (Option.isSome(env.githubToken)) plugins.push(githubTools({ token: Redacted.value(env.githubToken.value) }))
  return plugins
}
