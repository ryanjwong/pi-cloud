import { NodeHttpServer } from "@effect/platform-node"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { createServer } from "node:http"
import { layer, type ControlPlaneOptions } from "./ControlPlane.ts"

/** Serve the control plane on Node's HTTP server. */
export const serve = (options: ControlPlaneOptions & { readonly port: number; readonly host?: string }) =>
  HttpRouter.serve(layer(options)).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port: options.port, host: options.host }))
  )
