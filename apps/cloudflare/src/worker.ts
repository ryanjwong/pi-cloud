import { controlPlane, type Env } from "./env.ts"
import { forwarded } from "./paths.ts"

export { ControlPlane } from "./ControlPlane.ts"
export { SessionHost } from "./SessionHost.ts"

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    if (!forwarded(new URL(request.url).pathname)) return new Response("Not found", { status: 404 })
    return controlPlane(env).fetch(request as never) as unknown as Promise<Response>
  }
}
