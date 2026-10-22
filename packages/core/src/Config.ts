import { Context, Layer } from "effect"

export interface ControlPlaneSettings {
  readonly publicUrl: string
  readonly leaseTtlMs: number
  readonly attachTimeoutMs: number
  readonly commandTimeoutMs: number
  readonly recoveryIntervalMs: number
  readonly eventLogLimit: number
}

export const defaultSettings = (publicUrl: string): ControlPlaneSettings => ({
  publicUrl,
  leaseTtlMs: 15_000,
  attachTimeoutMs: 30_000,
  commandTimeoutMs: 30_000,
  recoveryIntervalMs: 5_000,
  eventLogLimit: 2_000
})

export class ControlPlaneConfig extends Context.Service<ControlPlaneConfig, ControlPlaneSettings>()(
  "@pi-cloud/control-plane/ControlPlaneConfig"
) {
  static readonly layer = (settings: Partial<ControlPlaneSettings> & { readonly publicUrl: string }) =>
    Layer.succeed(ControlPlaneConfig, { ...defaultSettings(settings.publicUrl), ...settings })
}
