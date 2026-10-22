import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { entryText, PiCloud } from "@pi-cloud/client"
import { modelProviders } from "@pi-cloud/runner"
import fc from "fast-check"
import { Effect, Schedule } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

const faux = fauxProvider()
/** Text of the newest user message in a model request. */
const lastPrompt = (context: unknown) => {
  const messages = (context as { messages: Array<{ role: string; content: unknown }> }).messages.filter((message) => message.role === "user")
  const content = messages.at(-1)?.content
  return typeof content === "string" ? content : (content as Array<{ text?: string }>).map((part) => part.text ?? "").join("")
}
let delays: Array<number> = []
// Every answer names the prompt it answers, after a random delay, so crashes land mid-generation.
const answer = (context: unknown) =>
  new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) =>
    setTimeout(() => resolve(fauxAssistantMessage(`re: ${lastPrompt(context)}`)), delays.shift() ?? 20)
  )

let deployment: LocalDeployment
/** Kills that hit a session while its runner was hosting it. */
let crashes = 0
beforeAll(async () => {
  faux.setResponses(Array.from({ length: 2_000 }, () => answer))
  deployment = await startLocal({
    port: 41_000 + Math.floor(Math.random() * 10_000),
    settings: { leaseTtlMs: 600, recoveryIntervalMs: 150, attachTimeoutMs: 5_000 },
    runner: { idleMs: 10_000, plugins: [modelProviders(faux.provider)] }
  })
})
afterAll(() => deployment.stop())

describe("exactly-once under crashes", () => {
  it("records every prompt once and answers it once, however often runners die", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }),
        fc.array(fc.integer({ min: 0, max: 600 }), { minLength: 1, maxLength: 3 }),
        fc.array(fc.integer({ min: 0, max: 150 }), { minLength: 20, maxLength: 20 }),
        async (count, kills, modelDelays) => {
          delays = [...modelDelays]
          await Effect.runPromise(Effect.gen(function*() {
            const api = yield* PiCloud
            const session = yield* api.sessions.create({ payload: { spec: { model: { provider: "faux", modelId: "faux-1" } } } })
            const prompts = Array.from({ length: count }, (_, index) => `prompt ${index} of ${session.id.slice(-6)}`)

            // Runners die on a schedule while the prompts go in.
            const killer = Effect.forEach(kills, (delay) =>
              Effect.andThen(Effect.sleep(delay), Effect.promise(async () => {
                if (deployment.runners.hosted().includes(session.id)) crashes++
                await deployment.runners.kill()
              })), { discard: true })
            // Each client retries its prompt, with the same request id, until the control plane accepts it.
            const submit = (content: string) =>
              api.sessions.submit({ params: { id: session.id }, payload: { content, requestId: `req-${content}`, whenBusy: "followUp" } }).pipe(
                Effect.retry({ times: 300, schedule: Schedule.spaced(50) })
              )
            const submitted = yield* Effect.all([
              Effect.forEach(prompts, (content) => submit(content).pipe(Effect.map((result) => ({ content, ...result })))),
              killer
            ], { concurrency: "unbounded" }).pipe(Effect.map(([results]) => results))

            // A retry after acceptance is the same submission.
            for (const { content, submissionId } of submitted) expect((yield* submit(content)).submissionId).toBe(submissionId)

            // Wait until every prompt has its answer, then check the transcript.
            const transcript = () =>
              api.sessions.entries({ params: { id: session.id }, query: { limit: 1000 } }).pipe(
                Effect.map(({ entries }) => entries.map((entry) => ({ kind: (entry as { kind: string }).kind, text: entryText(entry as never) })))
              )
            let entries = yield* transcript()
            for (let attempt = 0; attempt < 300 && !prompts.every((prompt) => entries.some((entry) => entry.text === `re: ${prompt}`)); attempt++) {
              yield* Effect.sleep(100)
              entries = yield* transcript()
            }
            const users = entries.filter((entry) => entry.kind === "pi.user").map((entry) => entry.text)
            const answers = entries.filter((entry) => entry.kind === "pi.assistant").map((entry) => entry.text)
            // Every prompt once, in the order it was submitted; every answer once.
            expect(users).toEqual(prompts)
            expect([...answers].sort()).toEqual(prompts.map((prompt) => `re: ${prompt}`).sort())
          }).pipe(Effect.provide(PiCloud.layer({ url: deployment.url }))))
        }
      ),
      { numRuns: 6 }
    )
    // The property is only as good as the crashes it survived.
    expect(crashes).toBeGreaterThan(3)
  }, 240_000)
})
