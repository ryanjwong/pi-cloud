import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { extensions, modelProviders, type RunnerPlugin } from "@pi-cloud/runner"
import { sandboxes } from "@pi-cloud/sandbox"
import { localSandboxes } from "@pi-cloud/sandbox-local"
import { join } from "node:path"

/**
 * The default plugin set for a Node runner: Anthropic and OpenAI models (keys from the environment), Pi's coding
 * tools, and sandboxes as local directories. Swap or extend freely; nothing else depends on this list.
 */
export const defaultPlugins = (dataDir: string): ReadonlyArray<RunnerPlugin> => [
  modelProviders(anthropicProvider, openaiProvider),
  extensions("coding", CodingTools),
  sandboxes({
    providers: [localSandboxes({ root: join(dataDir, "sandboxes") })],
    templates: { scratch: { provider: "local" } }
  })
]
