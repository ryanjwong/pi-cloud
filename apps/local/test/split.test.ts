import { NodeHttpServer } from "@effect/platform-node"
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { entryText, PiCloud } from "@pi-cloud/client"
import { ControlPlane } from "@pi-cloud/control-plane"
import { RunnerDispatcher } from "@pi-cloud/core"
import { modelProviders, RunnerHost } from "@pi-cloud/runner"
import { Effect, Fiber, Layer } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { createServer, type Server } from "node:http"
import { Readable } from "node:stream"
import { describe, expect, it } from "vitest"

/** Serve a fetch-style handler on Node, the way any substrate would expose the runner host. */
const serveFetch = (port: number, handler: (request: Request) => Promise<Response>) =>
  new Promise<Server>((resolve) => {
    const server = createServer(async (req, res) => {
      const response = await handler(new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method === "POST" ? (Readable.toWeb(req) as ReadableStream) : undefined,
        duplex: "half"
      } as RequestInit))
      res.writeHead(response.status)
      res.end(await response.text())
    })
    server.listen(port, "127.0.0.1", () => resolve(server))
  })

describe("split deployment", () => {
  it("wakes a runner host in another server over HTTP, authenticated by the shared secret", async () => {
    const secret = "runner-secret"
    const base = 41_000 + Math.floor(Math.random() * 10_000)
    const controlUrl = `http://127.0.0.1:${base}`
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage("answered by a remote runner")])

    const runners = new RunnerHost({ plugins: [modelProviders(faux.provider)], secret, idleMs: 2_000 })
    const runnerServer = await serveFetch(base + 1, runners.handler)

    // An unauthenticated wake is refused.
    const refused = await fetch(`http://127.0.0.1:${base + 1}/wake`, {
      method: "POST",
      body: JSON.stringify({ sessionId: "x", controlPlaneUrl: controlUrl })
    })
    expect(refused.status).toBe(401)

    const control = Effect.runFork(Layer.launch(HttpRouter.serve(ControlPlane.layer({
      settings: { publicUrl: controlUrl },
      runnerSecret: secret,
      dispatcher: RunnerDispatcher.http({ url: `http://127.0.0.1:${base + 1}/wake`, secret }).pipe(
        Layer.provide(FetchHttpClient.layer)
      )
    }), { disableLogger: true }).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { port: base, host: "127.0.0.1" }))
    )))

    try {
      await Effect.runPromise(Effect.gen(function*() {
        const client = yield* PiCloud
        yield* Effect.sleep(300)
        const session = yield* client.sessions.create({ payload: { spec: { model: { provider: "faux", modelId: "faux-1" } } } })
        const submitted = yield* client.sessions.submit({ params: { id: session.id }, payload: { content: "hi" } })
        while (true) {
          const record = yield* client.sessions.submission({
            params: { id: session.id, submissionId: submitted.submissionId }
          })
          if ((record as { status?: string } | null)?.status === "done") break
          yield* Effect.sleep(100)
        }
        const { entries } = yield* client.sessions.entries({ params: { id: session.id }, query: {} })
        expect(entries.map((entry) => entryText(entry as never))).toContain("answered by a remote runner")
        expect(runners.hosted()).toContain(session.id)
      }).pipe(Effect.provide(PiCloud.layer({ url: controlUrl }))))
    } finally {
      await runners.close()
      runnerServer.close()
      await Effect.runPromise(Fiber.interrupt(control))
    }
  }, 30_000)
})
