/**
 * Pi's coding-agent internals its durable agent's system prompt is built from. The published package
 * only exports its top-level API, so these load the same modules from the installed package's files by path.
 * They are pinned to `@earendil-works/pi-coding-agent` 1.1.0; another version may move them.
 */
const dist = new URL(".", import.meta.resolve("@earendil-works/pi-coding-agent"))
const load = (path: string): Promise<any> => import(new URL(path, dist).href)

export const { getAgentDir } = await load("config.js") as typeof import("pi-internal/config.js")
export const { SettingsManager } = await load("core/settings-manager.js") as typeof import(
  "pi-internal/core/settings-manager.js"
)
export const { loadProjectContextFiles } = await load("core/resource-loader.js") as typeof import(
  "pi-internal/core/resource-loader.js"
)
export const { loadSkills } = await load("core/skills.js") as typeof import("pi-internal/core/skills.js")
export const { buildSystemPromptSections } = await load("core/system-prompt.js") as typeof import(
  "pi-internal/core/system-prompt.js"
)
export const { bashToolSystemPromptContribution } = await load("core/tools/bash.js") as typeof import(
  "pi-internal/core/tools/bash.js"
)
export const { editToolSystemPromptContribution } = await load("core/tools/edit.js") as typeof import(
  "pi-internal/core/tools/edit.js"
)
export const { readToolSystemPromptContribution } = await load("core/tools/read.js") as typeof import(
  "pi-internal/core/tools/read.js"
)
export const { writeToolSystemPromptContribution } = await load("core/tools/write.js") as typeof import(
  "pi-internal/core/tools/write.js"
)

export type SettingsManager = import("pi-internal/core/settings-manager.js").SettingsManager
export type Skill = import("pi-internal/core/skills.js").Skill
