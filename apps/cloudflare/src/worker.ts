import { CONTROL_PLANE, type Env } from "./env.ts"

export { ControlPlane } from "./ControlPlane.ts"
export { SessionHost } from "./SessionHost.ts"

/**
 * Whether a path is part of the public API. Only these reach the control plane object from outside: the runner RPC
 * (`/internal/...`) is for session hosts, which call the object directly. An allowlist rather than a denylist, so no
 * spelling of a path (`//internal`, percent-encoding, ...) can reach anything else.
 */
const isPublic = (path: string) =>
  path === "/health" || path === "/docs" || path === "/openapi.json" || /^\/v1\/[A-Za-z0-9]/.test(path)

/**
 * pi-cloud on Cloudflare. Every public request (the REST API, the service API's WebSocket at `/v1/pi`, triggers and
 * sources) goes to the one control plane object.
 */
export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const path = new URL(request.url).pathname
    if (!isPublic(path) || path.includes("%") || path.includes("//")) return new Response("Not found", { status: 404 })
    return env.CONTROL_PLANE.getByName(CONTROL_PLANE).fetch(request as never) as unknown as Promise<Response>
  }
}
