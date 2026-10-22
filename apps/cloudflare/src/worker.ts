import { CONTROL_PLANE, type Env } from "./env.ts"
import { forwarded } from "./paths.ts"

export { ControlPlane } from "./ControlPlane.ts"
export { SessionHost } from "./SessionHost.ts"

/**
 * pi-cloud on Cloudflare. Every public request (the REST API, the service API's WebSocket at `/v1/pi`, triggers and
 * sources) goes to the one control plane object.
 */
export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    if (!forwarded(new URL(request.url).pathname)) return new Response("Not found", { status: 404 })
    return env.CONTROL_PLANE.getByName(CONTROL_PLANE).fetch(request as never) as unknown as Promise<Response>
  }
}
