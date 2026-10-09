import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { entryText, PiCloud } from "@pi-cloud/client"
import { modelProviders } from "@pi-cloud/runner"
import { sqliteSessions, sqliteState } from "@pi-cloud/storage-sqlite"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

let deployment: LocalDeployment | undefined
let dir: string | undefined

afterEach(async () => {
  await deployment?.stop()
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  deployment = undefined
})

const waitDone = (sessionId: string, submissionId: number) =>
  Effect.gen(function*() {
    const client = yield* PiCloud
    while (true) {
      const record = yield* client.sessions.submission({ params: { id: sessionId as never, submissionId } })
      if ((record as { status?: string } | null)?.status === "done") return
      yield* Effect.sleep(100)
    }
  })

describe("sqlite stores", () => {
  it("keeps sessions and transcripts across a control plane restart", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-cloud-sqlite-"))
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")])
    const port = 41_000 + Math.floor(Math.random() * 10_000)
    const start = () =>
      startLocal({
        port,
        sessions: sqliteSessions({ file: join(dir!, "sessions.sqlite") }),
        state: sqliteState({ directory: join(dir!, "state") }),
        runner: { plugins: [modelProviders(faux.provider)], idleMs: 300 }
      })

    deployment = await start()
    const sessionId = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* PiCloud
      const session = yield* client.sessions.create({ payload: { spec: { model: { provider: "faux", modelId: "faux-1" } } } })
      const submitted = yield* client.sessions.submit({ params: { id: session.id }, payload: { content: "one" } })
      yield* waitDone(session.id, submitted.submissionId)
      return session.id
    }).pipe(Effect.provide(PiCloud.layer({ url: deployment.url }))))
    await deployment.stop()

    deployment = await start()
    await Effect.runPromise(Effect.gen(function*() {
      const client = yield* PiCloud
      const sessions = yield* client.sessions.list()
      expect(sessions.map((session) => session.id)).toContain(sessionId)
      const submitted = yield* client.sessions.submit({ params: { id: sessionId as never }, payload: { content: "two" } })
      yield* waitDone(sessionId, submitted.submissionId)
      const { entries } = yield* client.sessions.entries({ params: { id: sessionId as never }, query: {} })
      const texts = entries.map((entry) => entryText(entry as never))
      expect(texts).toEqual(expect.arrayContaining(["one", "first answer", "two", "second answer"]))
    }).pipe(Effect.provide(PiCloud.layer({ url: deployment.url }))))
  }, 30_000)
})
