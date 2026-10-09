import {
  BindingStore,
  ControlPlaneConfig,
  type ControlPlaneSettings,
  EventHub,
  LeaseManager,
  type RunnerDispatcher,
  SessionStore,
  StateStore
} from "@pi-cloud/core"
import { PublicApi, RUNNER_RPC_PATH, RunnerRpcs } from "@pi-cloud/protocol"
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { ApiAuthLive, ClientAuth, RunnerAuth } from "./http/Auth.ts"
import { ChannelRoute } from "./http/ChannelLive.ts"
import { PublicApiHandlers } from "./http/PublicApiLive.ts"
import { RunnerRpcLive } from "./http/RunnerRpcLive.ts"
import { Runners } from "./Runners.ts"
import { Sessions } from "./Sessions.ts"
import { Workspaces } from "./Workspaces.ts"

/**
 * A routes layer that builds on the control plane: it may use `Sessions` (create sessions, run commands, follow
 * events) and add HTTP routes. This is where hosted sources (a Slack bridge) and event triggers (a GitHub webhook)
 * plug in.
 */
export type Extension = Layer.Layer<never, never, HttpRouter.HttpRouter | Sessions | BindingStore>

/**
 * Every HTTP route of the control plane, given its services:
 *
 * - `/v1/sessions/...` the public API, with `/openapi.json` and `/docs` describing it,
 * - `/v1/sessions/:id/channel` the WebSocket session channel (which also serves client workspaces),
 * - `/internal/runner` the runner RPC,
 * - whatever the extensions add.
 */
export const routes = (extensions: ReadonlyArray<Extension> = []) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(PublicApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(PublicApiHandlers),
      Layer.provide(ApiAuthLive)
    ),
    HttpApiScalar.layer(PublicApi, { path: "/docs" }),
    ChannelRoute,
    RpcServer.layerHttp({ group: RunnerRpcs, path: RUNNER_RPC_PATH, protocol: "http" }).pipe(
      Layer.provide(RunnerRpcLive),
      Layer.provide(RpcSerialization.layerNdjson)
    ),
    ...extensions
  ).pipe(Layer.provide(Sessions.layer.pipe(Layer.provideMerge(Runners.layer))))

export interface ControlPlaneOptions {
  readonly settings: Partial<ControlPlaneSettings> & { readonly publicUrl: string }
  /** How runners are started. Required: it is the one substrate-specific piece. */
  readonly dispatcher: Layer.Layer<RunnerDispatcher>
  /** Accepted public API keys. Omit to accept every request (development only). Ignored with `clientAuth`. */
  readonly apiKeys?: ReadonlyArray<string>
  /** Replaces API-key authentication for every public surface. */
  readonly clientAuth?: Layer.Layer<ClientAuth>
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
  /** Defaults to bindings in memory. */
  readonly bindings?: Layer.Layer<BindingStore>
  /** Extra routes built on `Sessions`: hosted sources, event triggers, admin endpoints, ... */
  readonly extensions?: ReadonlyArray<Extension>
  /** How long a workspace call waits for a client to serve the workspace. Default 10 minutes. */
  readonly workspaceWaitMs?: number
}

/** The control plane's routes with every service provided. Serve it with `HttpRouter.serve` or `toWebHandler`. */
export const layer = (options: ControlPlaneOptions) => {
  const config = ControlPlaneConfig.layer(options.settings)
  const ttlMs = options.settings.leaseTtlMs ?? 15_000
  const logLimit = options.settings.eventLogLimit ?? 2_000
  return routes(options.extensions).pipe(
    Layer.provide([
      options.dispatcher,
      options.sessions ?? SessionStore.memory,
      options.state ?? StateStore.memory,
      options.leases ?? LeaseManager.memory({ ttlMs }),
      options.events ?? EventHub.memory({ logLimit }),
      options.bindings ?? BindingStore.memory,
      Workspaces.make({ waitMs: options.workspaceWaitMs }),
      RunnerAuth.sharedSecret(options.runnerSecret),
      options.clientAuth ?? ClientAuth.apiKeys(options.apiKeys),
      config
    ])
  )
}

/** A fetch-style handler for runtimes that speak web `Request`/`Response` (Bun, Deno, Workers, ...). */
export const toWebHandler = (options: ControlPlaneOptions) =>
  HttpRouter.toWebHandler(layer(options).pipe(Layer.provide(HttpServer.layerServices)))
