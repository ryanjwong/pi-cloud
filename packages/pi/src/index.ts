import { definePlugin, type RunnerPlugin } from "@pi-cloud/runner"
import { createPiPrompt } from "./agent/prompt.ts"
import { Subagent } from "./agent/subagent.ts"
import { SettingsManager } from "./internal.ts"

export { createPiPrompt } from "./agent/prompt.ts"
export { Subagent } from "./agent/subagent.ts"

/**
 * Pi's coding agent, as its durable mode runs it: Pi's system prompt (tools, rules, docs, `AGENTS.md`, skills, the
 * working directory) and the `subagent` tool, on top of Pi Durable's `CodingTools`. Settings and skills come from
 * the runner's Pi agent directory (`~/.pi/agent`); project files from the directory the tools run in.
 */
export const piAgent = (options: { readonly cwd?: string } = {}): RunnerPlugin =>
  definePlugin({
    name: "pi",
    setup: () => {
      const cwd = options.cwd ?? process.cwd()
      return { extensions: [createPiPrompt(SettingsManager.create(cwd), cwd), Subagent] }
    }
  })
