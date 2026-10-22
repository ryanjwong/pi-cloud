import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { entryText, PiCloud } from "@pi-cloud/client"
import { pullDispatcher } from "@pi-cloud/control-plane"
import { serve } from "@pi-cloud/control-plane/node"
import { modelProviders, RunnerHost } from "@pi-cloud/runner"
import { Effect, Fiber, Layer } from "effect"
import { describe, expect, it } from "vitest"

describe("split deployment", () => {
  it("wakes a runner host that has no inbound port over its own authenticated WebSocket", async () => {
    const secret = "runner-secret"
    const port = 41_000 + Math.floor(Math.random() * 10_000)
    const controlUrl = `http://127.0.0.1:${port}`
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage("answered by a remote runner")])

    expect(() => new RunnerHost({ plugins: [] }).connect()).toThrow(/secret and a control plane URL/)
    const runners = new RunnerHost({ plugins: [modelProviders(faux.provider)], secret, controlPlaneUrl: controlUrl, idleMs: 2_000 })
    const control = Effect.runFork(Layer.launch(serve({
      port,
      settings: { publicUrl: controlUrl, attachTimeoutMs: 5_000 },
      apiKeys: ["client-key"],
      runnerSecret: secret,
      dispatcher: pullDispatcher
    })))

    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      for (const authorization of [undefined, "Bearer wrong", "Bearer client-key"]) {
        const headers: Record<string, string> = authorization === undefined ? {} : { authorization }
        expect((await fetch(`${controlUrl}/internal/runner/wake`, { headers })).status, authorization).toBe(401)
        const response = await fetch(`${controlUrl}/internal/runner`, {
          method: "POST",
          headers: { "content-type": "application/ndjson", ...headers },
          body: `${JSON.stringify({ _tag: "Request", id: "1", tag: "CredentialList", payload: { sessionId: "x", token: "y" }, headers: [] })}\n`
        })
        expect(await response.text(), authorization).toContain("Invalid runner credentials")
      }
      runners.connect()
      await Effect.runPromise(Effect.gen(function*() {
        const client = yield* PiCloud
        const session = yield* client.sessions.create({ payload: { spec: { model: { provider: "faux", modelId: "faux-1" } } } })
        const submitted = yield* client.sessions.submit({ params: { id: session.id }, payload: { content: "hi" } })
        while (true) {
          const record = yield* client.sessions.submission({ params: { id: session.id, submissionId: submitted.submissionId } })
          if ((record as { status?: string } | null)?.status === "done") break
          yield* Effect.sleep(100)
        }
        const { entries } = yield* client.sessions.entries({ params: { id: session.id }, query: {} })
        expect(entries.map((entry) => entryText(entry as never))).toContain("answered by a remote runner")
        expect(runners.hosted()).toContain(session.id)
      }).pipe(Effect.provide(PiCloud.layer({ url: controlUrl, apiKey: "client-key" }))))
    } finally {
      await runners.close()
      await Effect.runPromise(Fiber.interrupt(control))
    }
  }, 30_000)
})
