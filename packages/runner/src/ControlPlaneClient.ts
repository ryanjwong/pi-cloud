import { RUNNER_RPC_PATH, RunnerRpcs } from "@pi-cloud/protocol"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc"

export type ControlPlaneClient = RpcClient.FromGroup<typeof RunnerRpcs, RpcClientError.RpcClientError>

export interface ControlPlaneConnection {
  /** Base URL of the control plane, e.g. `https://control.example.com`. */
  readonly url: string
  /** Shared runner secret, sent as a bearer token. */
  readonly secret?: string | undefined
}

/** The runner RPC client over plain HTTP: fetch is the only thing the substrate has to provide. */
export const makeClient = (connection: ControlPlaneConnection) =>
  RpcClient.make(RunnerRpcs).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({
        url: new URL(RUNNER_RPC_PATH, connection.url).toString(),
        transformClient: (client) =>
          connection.secret === undefined
            ? client
            : HttpClient.mapRequest(client, HttpClientRequest.bearerToken(connection.secret!))
      }).pipe(Layer.provide([RpcSerialization.layerNdjson, FetchHttpClient.layer]))
    )
  )
