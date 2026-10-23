import { type Env, LEGACY_CONTROL_PLANE } from "../src/env.ts"
import { SessionHost as Current } from "../src/SessionHost.ts"

export { ControlPlane } from "../src/ControlPlane.ts"

export class SessionHost extends Current {
  constructor(...[ctx, env]: ConstructorParameters<typeof Current>) {
    super(ctx, { ...env, CONTROL_PLANE: { getByName: () => env.CONTROL_PLANE.getByName(LEGACY_CONTROL_PLANE) } } as never)
  }
}

export default {
  fetch: (request: Request, env: Env) => env.CONTROL_PLANE.getByName(LEGACY_CONTROL_PLANE).fetch(request as never)
}
