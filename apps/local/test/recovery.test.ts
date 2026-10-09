import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { entryText, PiCloud } from "@pi-cloud/client"
import { makeClient, modelProviders } from "@pi-cloud/runner"
import { Effect, Exit, Fiber, Option, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

const model = { provider: "faux", modelId: "faux-1" }
let deployment: LocalDeployment | undefined

afterEach(async () => {
  await deployment?.stop()
  deployment = undefined
})

const port = () => 41_000 + Math.floor(Math.random() * 10_000)
const settings = { leaseTtlMs: 1_500, recoveryIntervalMs: 250, attachTimeoutMs: 5_000 }

const poll = <A>(effect: Effect.Effect<A, unknown, PiCloud>, until: (value: A) => boolean, timeoutMs = 15_000) =>
  Effect.gen(function*() {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const value = yield* effect
      if (until(value)) return value
      if (Date.now() > deadline) return yield* Effect.die(new Error("Timed out polling"))
      yield* Effect.sleep(100)
    }
  })

describe("crash recovery", () => {
  it("resumes a turn on a new runner after the old one dies mid-generation", async () => {
    const faux = fauxProvider()
    let hang: () => void = () => {}
    faux.setResponses([
      // The first attempt never finishes: the runner is killed while it waits.
      () => new Promise((resolve) => { hang = () => resolve(fauxAssistantMessage("too late")) }),
      fauxAssistantMessage("Recovered answer")
    ])
    deployment = await startLocal({
      port: port(),
      settings,
      runner: { plugins: [modelProviders(faux.provider)], idleMs: 5_000 }
    })
    const local = deployment

    const program = Effect.gen(function*() {
      const client = yield* PiCloud
      const session = yield* client.sessions.create({ payload: { spec: { model } } })
      const submitted = yield* client.sessions.submit({ params: { id: session.id }, payload: { content: "Work" } })

      // Wait for the generation to start, then kill the runner without releasing its lease.
      yield* Effect.promise(async () => {
        while (faux.state.callCount === 0) await new Promise((resolve) => setTimeout(resolve, 20))
        await local.runners.kill()
      })
      hang()

      // The control plane notices the abandoned lease, wakes a new runner, and Pi resumes the run.
      const record = yield* poll(
        client.sessions.submission({ params: { id: session.id, submissionId: submitted.submissionId } }),
        (value) => (value as { status?: string } | null)?.status === "done"
      )
      expect(record).toBeTruthy()
      const { entries } = yield* client.sessions.entries({ params: { id: session.id }, query: {} })
      const answers = entries.filter((entry: any) => entry.kind === "pi.assistant").map((entry) => entryText(entry as never))
      expect(answers.at(-1)).toBe("Recovered answer")
      expect(faux.state.callCount).toBe(2)
    })

    await Effect.runPromise(program.pipe(Effect.provide(PiCloud.layer({ url: local.url }))))
  }, 30_000)

  it("fences writes from a runner that lost its lease", async () => {
    deployment = await startLocal({ port: port(), settings, runner: { plugins: [] } })
    const local = deployment

    const program = Effect.gen(function*() {
      const api = yield* PiCloud
      const session = yield* api.sessions.create({ payload: {} })
      const rpc = yield* makeClient({ url: local.url })
      const first = yield* firstLease(rpc, session.id, "stale-runner")
      // A second runner cannot take a live lease.
      const held = yield* Effect.exit(firstLease(rpc, session.id, "eager-runner"))
      expect(Exit.isFailure(held)).toBe(true)

      // Once the first lease expires, a new runner takes over and the old token is fenced off.
      yield* Effect.sleep(settings.leaseTtlMs + 200)
      const second = yield* firstLease(rpc, session.id, "new-runner")
      expect(second.epoch).toBeGreaterThan(first.epoch)
      const stale = yield* Effect.exit(rpc.Storage({ sessionId: session.id, token: first.token, method: "mintId", args: [] }))
      expect(Exit.isFailure(stale)).toBe(true)
      const fresh = yield* rpc.Storage({ sessionId: session.id, token: second.token, method: "mintId", args: [] })
      expect(typeof fresh.value).toBe("number")
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(PiCloud.layer({ url: local.url }))))
  }, 30_000)
})

describe("runner reconnects", () => {
  it("delivers commands to a runner's newest connection and ends the old one", async () => {
    deployment = await startLocal({ port: port(), settings, runner: { plugins: [] } })
    const local = deployment

    const program = Effect.gen(function*() {
      const api = yield* PiCloud
      const session = yield* api.sessions.create({ payload: {} })
      const rpc = yield* makeClient({ url: local.url })

      // First connection: take the lease, then keep reading until the stream ends.
      const firstMessages: Array<string> = []
      let token = ""
      const first = yield* Effect.forkChild(
        rpc.Attach({ sessionId: session.id, runnerId: "flaky" }).pipe(
          Stream.runForEach((message) =>
            Effect.sync(() => {
              if (message._tag === "LeaseGranted") token = message.token
              firstMessages.push(message._tag)
            })
          )
        )
      )
      while (token === "") yield* Effect.sleep(20)

      // The same runner reconnects with its token and answers commands there.
      const second = yield* Effect.forkChild(
        rpc.Attach({ sessionId: session.id, runnerId: "flaky", token }).pipe(
          Stream.runForEach((message) =>
            message._tag === "Command" && message.command._tag === "Submit"
              ? rpc.Reply({
                sessionId: session.id,
                token,
                commandId: message.command.commandId,
                result: { _tag: "Ok", value: { submissionId: 42, conversationId: 1 } }
              })
              : Effect.void
          )
        )
      )
      yield* Fiber.join(first)
      expect(firstMessages).toEqual(["LeaseGranted"])

      const submitted = yield* api.sessions.submit({ params: { id: session.id }, payload: { content: "hello" } })
      expect(submitted.submissionId).toBe(42)
      yield* Fiber.interrupt(second)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(PiCloud.layer({ url: local.url }))))
  }, 30_000)
})

type Rpc = Effect.Success<ReturnType<typeof makeClient>>

/** Attach just long enough to receive the lease. */
const firstLease = (rpc: Rpc, sessionId: string, runnerId: string) =>
  Effect.gen(function*() {
    const first = yield* Stream.runHead(rpc.Attach({ sessionId, runnerId }))
    if (Option.isNone(first) || first.value._tag !== "LeaseGranted") return yield* Effect.die("no lease")
    return first.value
  })
