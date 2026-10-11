import type { Terminal } from "@earendil-works/pi-tui"
import { SettingsManager } from "./pi/internal.ts"
import { runDurableTui } from "./pi/DurableTui.ts"
import { project, type ProjectionOptions } from "./Projection.ts"

export { project, type Projection, type ProjectionOptions } from "./Projection.ts"
export type { Terminal } from "@earendil-works/pi-tui"

export interface TuiOptions extends ProjectionOptions {
  /** Defaults to the process's terminal. */
  readonly terminal?: Terminal
}

/**
 * Pi's own TUI on a pi-cloud session: the same editor, keybindings, theme, model picker, `/agents`, task panel and
 * message rendering as Pi, driven entirely by the public API. Your Pi settings (theme, keybindings) apply as with a
 * local Pi; the agent, its model credentials and its tools run in the cloud.
 */
export const runTui = async (options: TuiOptions): Promise<void> => {
  const projection = project(options)
  try {
    await projection.ready
    await runDurableTui(projection.source, projection.controller, SettingsManager.create(process.cwd()), options.terminal)
  } finally {
    await projection.close()
  }
}
