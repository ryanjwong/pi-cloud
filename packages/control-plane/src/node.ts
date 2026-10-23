import { NodeHttpServer } from "@effect/platform-node"
import { WEBSOCKET_PROTOCOL } from "@pi-cloud/protocol"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
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

export interface Listener {
  readonly url: string
  serve(options: ControlPlaneOptions, http?: { readonly disableLogger?: boolean }): Promise<void>
  close(): Promise<void>
}

export const listen = async (port = 0, host = "127.0.0.1"): Promise<Listener> => {
  const scope = Scope.makeUnsafe()
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void))
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect).catch(async (error: unknown) => {
    await close()
    throw error
  })
  const server = await run(Layer.buildWithScope(nodeServer(port, host), scope))
  const address = Context.get(server, HttpServer.HttpServer).address
  return {
    url: `http://${host}:${"port" in address ? address.port : port}`,
    close,
    serve: async (options, http) => {
      await run(Layer.buildWithScope(HttpRouter.serve(layer(bound(options, host)), http), scope).pipe(Effect.provide(server)))
    }
  }
}
