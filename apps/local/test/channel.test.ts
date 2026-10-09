import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { openChannel, PiCloud } from "@pi-cloud/client"
import { modelProviders } from "@pi-cloud/runner"
import { Effect, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

let deployment: LocalDeployment | undefined

afterEach(async () => {
  await deployment?.stop()
  deployment = undefined
})

type AgentEvent = { readonly type: string; readonly [key: string]: any }

describe("session channel", () => {
  it("runs prompts and agent commands over one WebSocket and streams events back", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] })
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")])
    deployment = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      apiKeys: ["key-1"],
      runner: { plugins: [modelProviders(faux.provider)], idleMs: 5_000 }
    })
    const local = deployment

    const program = Effect.gen(function*() {
      const api = yield* PiCloud
      const session = yield* api.sessions.create({ payload: { spec: { model: { provider: "faux", modelId: "faux-1" } } } })
      const channel = yield* openChannel({ url: local.url, apiKey: "key-1", sessionId: session.id })
      const seen: Array<AgentEvent> = []
      yield* channel.events.pipe(
        Stream.runForEach((batch) => Effect.sync(() => seen.push(...(batch.events as Array<AgentEvent>)))),
        Effect.forkScoped
      )
      const runEnds = (count: number) =>
        Effect.gen(function*() {
          while (seen.filter((event) => event.type === "run_end").length < count) yield* Effect.sleep(20)
        }).pipe(Effect.timeout(10_000))

      const first = yield* channel.command({ _tag: "Prompt", content: "one" })
      expect(first).toMatchObject({ _tag: "Ok", value: { conversationId: 1 } })
      yield* runEnds(1)

      // Switch the model for the next turn, over the same channel.
      expect(yield* channel.command({ _tag: "Configure", model: { provider: "faux", modelId: "faux-2" } })).toEqual({
        _tag: "Ok"
      })
      yield* channel.command({ _tag: "Prompt", content: "two" })
      yield* runEnds(2)
      const answers = seen.filter((event) => event.type === "message_end" && event.entry?.kind === "pi.assistant")
      expect(answers.map((event) => event.entry.model[0].model)).toEqual(["faux-1", "faux-2"])

      // Unknown plugin commands come back as errors, not dropped connections.
      const unknown = yield* channel.command({ _tag: "Custom", name: "nope", payload: null })
      expect(unknown).toMatchObject({ _tag: "Err", tag: "UnknownCommand" })

      // The same commands work over REST.
      const compacted = yield* api.sessions.command({ params: { id: session.id }, payload: { _tag: "Compact" } })
      expect(compacted.value).toHaveProperty("taskId")
      yield* api.sessions.command({ params: { id: session.id }, payload: { _tag: "Reset", handoff: "fresh start" } })
    })

    await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(PiCloud.layer({ url: local.url, apiKey: "key-1" })))
    )
  }, 30_000)

  it("refuses channels without a valid key", async () => {
    deployment = await startLocal({ port: 41_000 + Math.floor(Math.random() * 10_000), apiKeys: ["key-1"], runner: { plugins: [] } })
    const outcome = (token: string) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`${deployment!.url.replace("http", "ws")}/v1/sessions/whatever/channel?token=${token}`)
        socket.onopen = () => {
          socket.close()
          resolve("open")
        }
        socket.onerror = () => resolve("refused")
      })
    expect(await outcome("wrong")).toBe("refused")
  })
})
