import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { entryText, type EventBatch, followEvents, PiCloud } from "@pi-cloud/client"
import { modelProviders } from "@pi-cloud/runner"
import { Effect, Fiber, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

const model = { provider: "faux", modelId: "faux-1" }
let deployment: LocalDeployment | undefined

afterEach(async () => {
  await deployment?.stop()
  deployment = undefined
})

const port = () => 41_000 + Math.floor(Math.random() * 10_000)

/** Events of a session until `until` matches, as one flat list. */
const collect = (sessionId: string, until: (event: { type: string }) => boolean) =>
  followEvents(sessionId).pipe(
    Stream.flatMap((batch: EventBatch) => Stream.fromIterable(batch.events as ReadonlyArray<{ type: string }>)),
    Stream.takeUntil(until),
    Stream.runCollect
  )

describe("pi-cloud end to end", () => {
  it("runs a turn through the control plane and a woken runner", async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage("Hello from a runner")])
    deployment = await startLocal({ port: port(), runner: { plugins: [modelProviders(faux.provider)], idleMs: 2_000 } })

    const program = Effect.gen(function*() {
      const client = yield* PiCloud
      const session = yield* client.sessions.create({ payload: { title: "e2e", spec: { model } } })
      expect(session.runner.state).toBe("idle")

      const events = yield* Effect.forkChild(collect(session.id, (event) => event.type === "run_end"))
      yield* Effect.sleep(100)
      const submitted = yield* client.sessions.submit({
        params: { id: session.id },
        payload: { content: "Say hello", requestId: "first" }
      })
      const seen = yield* Fiber.join(events).pipe(Effect.timeout(10_000))
      const types = seen.map((event) => event.type)
      expect(types[0]).toBe("snapshot")
      expect(types).toContain("message_end")

      // Retrying with the same requestId returns the original submission instead of asking twice.
      const retried = yield* client.sessions.submit({
        params: { id: session.id },
        payload: { content: "Say hello", requestId: "first" }
      })
      expect(retried.submissionId).toBe(submitted.submissionId)

      // The transcript is read straight from the control plane's state store.
      const { entries } = yield* client.sessions.entries({ params: { id: session.id }, query: {} })
      const assistant = entries.find((entry: any) => entry.kind === "pi.assistant") as any
      expect(entryText(assistant)).toBe("Hello from a runner")

      const record = yield* client.sessions.submission({
        params: { id: session.id, submissionId: submitted.submissionId }
      })
      expect((record as any).status).toBe("done")

      const running = yield* client.sessions.get({ params: { id: session.id } })
      expect(running.runner.state).toBe("running")
    })

    await Effect.runPromise(program.pipe(Effect.provide(PiCloud.layer({ url: deployment.url }))))
  }, 20_000)
})
