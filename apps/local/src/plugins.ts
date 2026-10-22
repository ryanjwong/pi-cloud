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

export const loadTemplates = (file: string | undefined): Record<string, SandboxTemplate> => {
  const templates: Record<string, SandboxTemplate> = { scratch: { provider: "local" } }
  if (file === undefined) return templates
  try {
    return { ...templates, ...decodeTemplates(JSON.parse(readFileSync(file, "utf8"))) }
  } catch (error) {
    throw new Error(`SANDBOX_TEMPLATES_FILE ${file} is not a valid template file: ${error instanceof Error ? error.message : error}`)
  }
}

export const defaultPlugins = (env: RunnerEnv): ReadonlyArray<RunnerPlugin> => {
  const plugins: Array<RunnerPlugin> = [
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
  plugins.push(githubTools(Option.match(env.githubToken, { onNone: () => ({}), onSome: (token) => ({ token: Redacted.value(token) }) })))
  return plugins
}
