import { PublicApi, RUNNER_RPC_PATH, RunnerRpcs } from "@pi-cloud/protocol"
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { ControlPlaneConfig, type ControlPlaneSettings } from "./Config.ts"
import { apiKeys, RunnerAuth } from "./http/Auth.ts"
import { PublicApiHandlers } from "./http/PublicApiLive.ts"
import { RunnerRpcLive } from "./http/RunnerRpcLive.ts"
import { EventHub } from "./ports/EventHub.ts"
import { LeaseManager } from "./ports/LeaseManager.ts"
import type { RunnerDispatcher } from "./ports/RunnerDispatcher.ts"
import { SessionStore } from "./ports/SessionStore.ts"
import { StateStore } from "./ports/StateStore.ts"
import { Runners } from "./Runners.ts"

/**
 * Every HTTP route of the control plane, given its services:
 *
 * - `/v1/sessions/...` the public API, `/openapi.json` and `/docs` its description,
 * - `/internal/runner` the runner RPC.
 */
export const routes = Layer.mergeAll(
  HttpApiBuilder.layer(PublicApi, { openapiPath: "/openapi.json" }).pipe(Layer.provide(PublicApiHandlers)),
  HttpApiScalar.layer(PublicApi, { path: "/docs" }),
  RpcServer.layerHttp({ group: RunnerRpcs, path: RUNNER_RPC_PATH, protocol: "http" }).pipe(
    Layer.provide(RunnerRpcLive),
    Layer.provide(RpcSerialization.layerNdjson)
  )
).pipe(Layer.provide(Runners.layer))

export interface ControlPlaneOptions {
  readonly settings: Partial<ControlPlaneSettings> & { readonly publicUrl: string }
  /** How runners are started. Required: it is the one substrate-specific piece. */
  readonly dispatcher: Layer.Layer<RunnerDispatcher>
  /** Accepted public API keys. Omit to accept every request (development only). */
  readonly apiKeys?: ReadonlyArray<string>
  /** Shared secret runners authenticate with. Omit to accept every runner (development only). */
  readonly runnerSecret?: string
  /** Defaults to sessions in memory. */
  readonly sessions?: Layer.Layer<SessionStore>
  /** Defaults to Pi's memory storage. */
  readonly state?: Layer.Layer<StateStore>
  /** Defaults to leases in memory. */
  readonly leases?: Layer.Layer<LeaseManager>
  /** Defaults to an in-memory hub. */
  readonly events?: Layer.Layer<EventHub>
}

/** The control plane's routes with every service provided. Serve it with `HttpRouter.serve` or `toWebHandler`. */
export const layer = (options: ControlPlaneOptions) => {
  const config = ControlPlaneConfig.layer(options.settings)
  const ttlMs = options.settings.leaseTtlMs ?? 15_000
  const logLimit = options.settings.eventLogLimit ?? 2_000
  return routes.pipe(
    Layer.provide([
      options.dispatcher,
      options.sessions ?? SessionStore.memory,
      options.state ?? StateStore.memory,
      options.leases ?? LeaseManager.memory({ ttlMs }),
      options.events ?? EventHub.memory({ logLimit }),
      RunnerAuth.sharedSecret(options.runnerSecret),
      apiKeys(options.apiKeys),
      config
    ])
  )
}

/** A fetch-style handler for runtimes that speak web `Request`/`Response` (Bun, Deno, Workers, ...). */
export const toWebHandler = (options: ControlPlaneOptions) =>
  HttpRouter.toWebHandler(layer(options).pipe(Layer.provide(HttpServer.layerServices)))
