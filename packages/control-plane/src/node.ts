import { NodeHttpServer } from "@effect/platform-node"
import { WEBSOCKET_PROTOCOL } from "@pi-cloud/protocol"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { createServer } from "node:http"
import { layer, type ControlPlaneOptions } from "./ControlPlane.ts"
import { loopbackHosts } from "./http/Auth.ts"

export const websocket = {
  handleProtocols: (protocols: Set<string>) => protocols.has(WEBSOCKET_PROTOCOL) ? WEBSOCKET_PROTOCOL : false
} as const

export const nodeServer = (port: number, host = "127.0.0.1") => NodeHttpServer.layer(createServer, { port, host, websocket })

export const bound = <O extends ControlPlaneOptions>(options: O, host = "127.0.0.1"): O => ({
  ...options,
  auth: { ...options.auth, allowedHosts: options.auth?.allowedHosts ?? loopbackHosts(host, new URL(options.settings.publicUrl).hostname) }
})

export const serve = (options: ControlPlaneOptions & { readonly port: number; readonly host?: string }) =>
  HttpRouter.serve(layer(bound(options, options.host))).pipe(Layer.provide(nodeServer(options.port, options.host)))
