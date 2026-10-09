import { Context, Layer } from "effect"

export interface ControlPlaneSettings {
  /** URL runners use to reach this control plane. Sent to them when they are woken. */
  readonly publicUrl: string
  /** How long a lease lasts without renewal. Runners renew at a third of it. */
  readonly leaseTtlMs: number
  /** How long a request waits for a woken runner to attach. */
  readonly attachTimeoutMs: number
  /** How long a request waits for a runner to answer a command. */
  readonly commandTimeoutMs: number
  /** How often abandoned leases are checked, to wake their sessions so unfinished work resumes. */
  readonly recoveryIntervalMs: number
  /** Batches kept per conversation for clients that join late, before asking the runner for a fresh snapshot. */
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
