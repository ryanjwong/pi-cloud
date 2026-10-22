// A Worker that drives the Daytona provider, to check that its SDK runs on workerd. Used by test/daytona.test.ts.
import { Effect } from "effect"
import { daytonaSandboxes } from "@pi-cloud/sandbox-daytona"

export default {
  async fetch(request: Request): Promise<Response> {
    const apiUrl = new URL(request.url).searchParams.get("api")!
    const provider = daytonaSandboxes({ apiKey: "probe-key", apiUrl })
    const exit = await Effect.runPromiseExit(provider.create({ key: "probe/home", template: { provider: "daytona" }, env: {} }))
    return Response.json({ exit: String(exit) })
  }
}
