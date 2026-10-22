import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import type { RunnerEnv } from "@pi-cloud/config"
import { extensions, modelProviders, type RunnerPlugin } from "@pi-cloud/runner"
import { sandboxes } from "@pi-cloud/sandbox"
import { daytonaSandboxes } from "@pi-cloud/sandbox-daytona"
import { dockerSandboxes } from "@pi-cloud/sandbox-docker"
import { localSandboxes } from "@pi-cloud/sandbox-local"
import { piAgent } from "@pi-cloud/pi"
import { githubTools } from "@pi-cloud/tool-github"
import { Option, Redacted } from "effect"
import { join, resolve } from "node:path"

export const defaultPlugins = (env: RunnerEnv): ReadonlyArray<RunnerPlugin> => {
  if (env.unsafeLocalSandbox) console.warn("PI_CLOUD_UNSAFE_LOCAL_SANDBOX is on: local sandboxes run agent commands on this host without isolation")
  return [
    modelProviders(...builtinProviders()),
    extensions("coding", CodingTools),
    piAgent(),
    sandboxes({
      providers: [
        ...(env.unsafeLocalSandbox ? [localSandboxes({ root: join(resolve(env.dataDir), "sandboxes") })] : []),
        dockerSandboxes(),
        ...Option.match(env.daytonaApiKey, {
          onNone: () => [],
          onSome: (apiKey) => [daytonaSandboxes({ apiKey: Redacted.value(apiKey) })]
        })
      ]
    }),
    githubTools()
  ]
}
