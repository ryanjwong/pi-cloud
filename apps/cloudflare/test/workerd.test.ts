import type { ConversationView } from "@earendil-works/pi-durable"
import { connectServices } from "@pi-cloud/client"
import { type ChildProcess, spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const port = 46_000 + Math.floor(Math.random() * 2_000)
const url = `http://127.0.0.1:${port}`
let state: string
let wrangler: ChildProcess | undefined

/** The Worker in a local workerd, with its Durable Objects' SQLite in `state`. */
const start = async () => {
  wrangler = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: "ignore",
    detached: true
  })
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) }).then((response) => response.ok, () => false)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("wrangler dev did not start")
}
const stop = async () => {
  if (wrangler?.pid !== undefined) process.kill(-wrangler.pid, "SIGTERM")
  wrangler = undefined
  await new Promise((resolve) => setTimeout(resolve, 1_000))
}

beforeAll(async () => {
  state = await mkdtemp(join(tmpdir(), "pi-cloud-workerd-"))
  await start()
}, 90_000)
afterAll(async () => {
  await stop()
  await rm(state, { recursive: true, force: true })
})

const entries = (view: unknown) => (view as ConversationView).entries.map((entry) => entry.kind)

describe("pi-cloud on Cloudflare (local workerd)", () => {
  it("runs sessions in their own objects against the control plane's central store, across restarts", async () => {
    const connection = await connectServices({ url })
    const created = await (await connection.sessions()).create({ title: "on cloudflare", spec: {} })
    // The first reference wakes the session's object, which takes the lease, loads its replica and links back.
    const main = await connection.conversation(created.id)
    const first = await main.prompt({ message: "hello from workerd" })
    expect(first.accepted).toBe(true)
    // No model is configured on this Worker, so Pi settles the prompt unanswered; it is committed all the same.
    expect(await main.waitForPrompt({ operationId: first.accepted ? first.operationId : "" })).toEqual({ status: "unanswered", reason: "no_model" })
    expect(entries(main.view.value)).toEqual(["pi.user"])
    main.release()
    await connection.close()

    // The runner RPC is not public.
    expect((await fetch(`${url}/internal/runner/`, { method: "POST" })).status).toBe(404)

    // Everything is in the control plane object's SQLite: a fresh runtime has the session, and a fresh session
    // object continues it from a copy.
    await stop()
    await start()
    const listed = await fetch(`${url}/v1/sessions`).then((response) => response.json()) as Array<{ id: string; title?: string }>
    expect(listed.find((session) => session.id === created.id)?.title).toBe("on cloudflare")
    const again = await connectServices({ url })
    const resumed = await again.conversation(created.id)
    const second = await resumed.prompt({ message: "second prompt" })
    if (second.accepted) await resumed.waitForPrompt({ operationId: second.operationId })
    expect(entries(resumed.view.value)).toEqual(["pi.user", "pi.user"])
    const rest = await fetch(`${url}/v1/sessions/${created.id}/entries?limit=100`).then((response) => response.json()) as { entries: Array<{ kind: string }> }
    expect(rest.entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.user"])
    resumed.release()
    await again.close()
  }, 120_000)
})
