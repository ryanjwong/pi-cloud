import { ControlPlane as Current } from "../src/ControlPlane.ts"
import { LEGACY_CONTROL_PLANE } from "../src/env.ts"

export { SessionHost } from "../src/SessionHost.ts"
export { default } from "../src/worker.ts"

export class ControlPlane extends Current {
  override retire() {
    if (this.ctx.id.name === LEGACY_CONTROL_PLANE) throw new TypeError("The RPC receiver does not implement the method \"retire\".")
    return super.retire()
  }
}
