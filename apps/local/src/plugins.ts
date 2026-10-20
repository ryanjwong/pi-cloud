import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import type { RunnerEnv } from "@pi-cloud/config"
import { SandboxTemplate } from "@pi-cloud/protocol"
import { extensions, modelProviders, type RunnerPlugin } from "@pi-cloud/runner"
import { sandboxes } from "@pi-cloud/sandbox"
import { daytonaSandboxes } from "@pi-cloud/sandbox-daytona"
import { dockerSandboxes } from "@pi-cloud/sandbox-docker"
import { localSandboxes } from "@pi-cloud/sandbox-local"
import { piAgent } from "@pi-cloud/pi"
import { githubTools } from "@pi-cloud/tool-github"
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
 * The plugin set of a Node runner: every pi-ai model provider (API keys or `pi-cloud login` subscriptions), Pi's coding agent (its tools, system prompt and
 * subagents), sandboxes with the configured templates (`local` directories, `docker` containers, and `daytona` when
 * `DAYTONA_API_KEY` is set), and GitHub tools when `GITHUB_TOKEN` is set. Swap or extend freely.
 */
export const defaultPlugins = (env: RunnerEnv): ReadonlyArray<RunnerPlugin> => {
  const plugins: Array<RunnerPlugin> = [
    // Every built-in provider: each is usable once it has a credential, an API key in the runner's environment or a
    // login stored with `pi-cloud login` (ChatGPT/Codex, Claude Pro/Max, GitHub Copilot, ...).
    modelProviders(...builtinProviders()),
    extensions("coding", CodingTools),
    piAgent(),
    sandboxes({
      providers: [
        localSandboxes({ root: join(resolve(env.dataDir), "sandboxes") }),
        dockerSandboxes(),
        ...Option.match(env.daytonaApiKey, {
          onNone: () => [],
          onSome: (apiKey) => [daytonaSandboxes({ apiKey: Redacted.value(apiKey) })]
        })
      ],
      templates: loadTemplates(Option.getOrUndefined(env.templatesFile))
    })
  ]
  if (Option.isSome(env.githubToken)) plugins.push(githubTools({ token: Redacted.value(env.githubToken.value) }))
  return plugins
}
