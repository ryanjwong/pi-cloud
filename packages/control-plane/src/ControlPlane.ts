import {
  BindingStore,
  ControlPlaneConfig,
  type ControlPlaneSettings,
  CredentialStore,
  EventHub,
  LeaseManager,
  type RunnerDispatcher,
  SessionSecrets,
  SessionStore,
  StateStore
} from "@pi-cloud/core"
import { PublicApi, RUNNER_RPC_PATH, RunnerRpcs } from "@pi-cloud/protocol"
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { adminKeys, ApiAuthLive, type AuthSettings, ClientAuth, requestGuard, RunnerAuth } from "./http/Auth.ts"
import { ChannelRoute } from "./http/ChannelLive.ts"
import { PublicApiHandlers } from "./http/PublicApiLive.ts"
import { RunnerRpcLive } from "./http/RunnerRpcLive.ts"
import { Runners } from "./Runners.ts"
import { ServiceHost } from "./services/ServiceHost.ts"
import { Sessions } from "./Sessions.ts"

export type Extension = Layer.Layer<never, never, HttpRouter.HttpRouter | Sessions | BindingStore>

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
  ).pipe(
    Layer.provideMerge(ServiceHost.layer),
    Layer.provide(Sessions.layer.pipe(Layer.provideMerge(Runners.layer)))
  )

export interface ControlPlaneOptions {
  readonly settings: Partial<ControlPlaneSettings> & { readonly publicUrl: string }
  readonly dispatcher: Layer.Layer<RunnerDispatcher, never, HttpRouter.HttpRouter | RunnerAuth>
  readonly apiKeys?: ReadonlyArray<string>
  readonly auth?: AuthSettings
  readonly clientAuth?: Layer.Layer<ClientAuth>
  readonly runnerSecret: string
  readonly sessions?: Layer.Layer<SessionStore>
  readonly state?: Layer.Layer<StateStore>
  readonly leases?: Layer.Layer<LeaseManager>
  readonly events?: Layer.Layer<EventHub>
  readonly bindings?: Layer.Layer<BindingStore>
  readonly credentials?: Layer.Layer<CredentialStore>
  readonly sessionSecrets?: Layer.Layer<SessionSecrets>
  readonly extensions?: ReadonlyArray<Extension>
}

export const layer = (options: ControlPlaneOptions) => {
  const config = ControlPlaneConfig.layer(options.settings)
  const ttlMs = options.settings.leaseTtlMs ?? 15_000
  const logLimit = options.settings.eventLogLimit ?? 2_000
  const runnerAuth = RunnerAuth.sharedSecret(options.runnerSecret)
  return Layer.mergeAll(routes(options.extensions), requestGuard(options.auth ?? {})).pipe(
    Layer.provide([
      options.dispatcher.pipe(Layer.provide(runnerAuth)),
      options.sessions ?? SessionStore.memory,
      options.state ?? StateStore.memory,
      options.leases ?? LeaseManager.memory({ ttlMs }),
      options.events ?? EventHub.memory({ logLimit }),
      options.bindings ?? BindingStore.memory,
      options.credentials ?? CredentialStore.memory,
      options.sessionSecrets ?? SessionSecrets.none,
      runnerAuth,
      options.clientAuth ?? ClientAuth.keys([...options.auth?.keys ?? [], ...adminKeys(options.apiKeys ?? [])]),
      config
    ])
  )
}

export const toWebHandler = (options: ControlPlaneOptions) =>
  HttpRouter.toWebHandler(layer(options).pipe(Layer.provide(HttpServer.layerServices)))
