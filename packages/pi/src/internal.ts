/**
 * Pi's coding-agent internals that its experimental durable agent and TUI are built from. The published package
 * only exports its top-level API, so these load the same modules from the installed package's files by path.
 * They are pinned to `@earendil-works/pi-coding-agent` 1.1.0; another version may move them.
 */
const dist = new URL(".", import.meta.resolve("@earendil-works/pi-coding-agent"))
const load = (path: string): Promise<any> => import(new URL(path, dist).href)

export const { getAgentDir } = await load("config.js") as typeof import("pi-internal/config.js")
export const { KeybindingsManager } = await load("core/keybindings.js") as typeof import("pi-internal/core/keybindings.js")
export const { SettingsManager } = await load("core/settings-manager.js") as typeof import(
  "pi-internal/core/settings-manager.js"
)
export const { createAllToolRenderers } = await load("core/tools/renderers/index.js") as typeof import(
  "pi-internal/core/tools/renderers/index.js"
)
export const { AssistantMessageComponent } = await load("modes/interactive/components/assistant-message.js") as typeof import(
  "pi-internal/modes/interactive/components/assistant-message.js"
)
export const { CustomEditor } = await load("modes/interactive/components/custom-editor.js") as typeof import(
  "pi-internal/modes/interactive/components/custom-editor.js"
)
export const { DynamicBorder } = await load("modes/interactive/components/dynamic-border.js") as typeof import(
  "pi-internal/modes/interactive/components/dynamic-border.js"
)
export const { formatTokens } = await load("modes/interactive/components/footer.js") as typeof import(
  "pi-internal/modes/interactive/components/footer.js"
)
export const { keyText } = await load("modes/interactive/components/keybinding-hints.js") as typeof import(
  "pi-internal/modes/interactive/components/keybinding-hints.js"
)
export const { WorkingStatusIndicator } = await load("modes/interactive/components/status-indicator.js") as typeof import(
  "pi-internal/modes/interactive/components/status-indicator.js"
)
export const { ToolExecutionComponent } = await load("modes/interactive/components/tool-execution.js") as typeof import(
  "pi-internal/modes/interactive/components/tool-execution.js"
)
export const { UserMessageComponent } = await load("modes/interactive/components/user-message.js") as typeof import(
  "pi-internal/modes/interactive/components/user-message.js"
)
export const { getEditorTheme, getMarkdownTheme, initTheme, theme } = await load("modes/interactive/theme/theme.js") as typeof import(
  "pi-internal/modes/interactive/theme/theme.js"
)
export const { InteractiveThemeController } = await load("modes/interactive/theme/theme-controller.js") as typeof import(
  "pi-internal/modes/interactive/theme/theme-controller.js"
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
export type StatusIndicator = import("pi-internal/modes/interactive/components/status-indicator.js").StatusIndicator
export type ToolRenderers = import("pi-internal/modes/interactive/components/tool-execution.js").ToolRenderers
export type Skill = import("pi-internal/core/skills.js").Skill
