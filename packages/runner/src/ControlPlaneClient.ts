import { RUNNER_RPC_PATH, RunnerRpcs } from "@pi-cloud/protocol"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc"

export type ControlPlaneClient = RpcClient.FromGroup<typeof RunnerRpcs, RpcClientError.RpcClientError>

export interface ControlPlaneConnection {
  readonly url: string
  readonly secret?: string | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
}

export const makeClient = (connection: ControlPlaneConnection) =>
  RpcClient.make(RunnerRpcs).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({
        url: new URL(RUNNER_RPC_PATH, connection.url).toString(),
        transformClient: (client) =>
          connection.secret === undefined
            ? client
            : HttpClient.mapRequest(client, HttpClientRequest.bearerToken(connection.secret!))
      }).pipe(Layer.provide([
        RpcSerialization.layerNdjson,
        FetchHttpClient.layer.pipe(
          Layer.provide(connection.fetch === undefined ? Layer.empty : Layer.succeed(FetchHttpClient.Fetch, connection.fetch))
        )
      ]))
    )
  )
