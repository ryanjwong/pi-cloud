import type { Terminal } from "@earendil-works/pi-tui"
import { SettingsManager } from "./pi/internal.ts"
import { runDurableTui } from "./pi/DurableTui.ts"
import { project, type ProjectionOptions } from "./Projection.ts"

export { runPicker as pick } from "./pi/DurableTui.ts"
export { project, type Projection, type ProjectionOptions } from "./Projection.ts"
export type { Terminal } from "@earendil-works/pi-tui"

export interface TuiOptions extends ProjectionOptions {
  readonly terminal?: Terminal
}

export const runTui = async (options: TuiOptions): Promise<void> => {
  const projection = project(options)
  try {
    await projection.ready
    await runDurableTui(projection.source, projection.controller, SettingsManager.create(process.cwd()), options.terminal)
  } finally {
    await projection.close()
  }
}
