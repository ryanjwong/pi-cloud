import { definePlugin, type RunnerPlugin } from "@pi-cloud/runner"
import { createPiPrompt } from "./agent/prompt.ts"
import { Subagent } from "./agent/subagent.ts"
import { SettingsManager } from "./internal.ts"

export { createPiPrompt } from "./agent/prompt.ts"
export { Subagent } from "./agent/subagent.ts"

export const piAgent = (options: { readonly cwd?: string } = {}): RunnerPlugin =>
  definePlugin({
    name: "pi",
    setup: () => {
      const cwd = options.cwd ?? process.cwd()
      return { extensions: [createPiPrompt(SettingsManager.create(cwd), cwd), Subagent] }
    }
  })
