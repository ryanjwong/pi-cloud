import { getSystemMessageText, type SystemMessage } from "@earendil-works/pi-ai"
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { type ExecutionEnv, ok } from "@earendil-works/pi-durable/env"
import type { CloudflareEnv } from "@pi-cloud/config"
import { definePlugin, modelProviders, type RunnerPlugin } from "@pi-cloud/runner"
import { SessionHost as Current } from "../src/SessionHost.ts"

export { ControlPlane } from "../src/ControlPlane.ts"
export { default } from "../src/worker.ts"

const cwd = "/home/daytona/repo"
const files: Record<string, string> = { [`${cwd}/AGENTS.md`]: "Run the linter before every commit." }
const faux = fauxProvider()
const echo = (): void =>
  faux.appendResponses([(context) => {
    echo()
    const system = context.messages.filter((message): message is SystemMessage => message.role === "system")
    return fauxAssistantMessage([...system.map(getSystemMessageText), ...system.flatMap((message) => message.toolsAdded ?? []).map((tool) => `tool: ${tool.name}`)].join("\n"))
  }])
echo()

const sandbox = {
  id: "fake-sandbox",
  cwd,
  exec: async (_command, options, context) => {
    options?.onOutput?.(`${Object.keys(files).join("\n")}\n`, context, { stream: "stdout" })
    return ok({ exitCode: 0 })
  },
  readTextFile: async (path: string) => ok(files[path]!)
} as Partial<ExecutionEnv> as ExecutionEnv

export class SessionHost extends Current {
  protected override plugins(env: CloudflareEnv): ReadonlyArray<RunnerPlugin> {
    return [definePlugin({ name: "fake-sandbox", setup: () => ({ env: () => sandbox }) }), modelProviders(faux.provider), ...super.plugins(env)]
  }
}
