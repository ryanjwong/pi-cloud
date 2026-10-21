import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import type { ConversationView } from "@earendil-works/pi-durable"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { connectServices, follow } from "@pi-cloud/client"
import { piAgent } from "@pi-cloud/pi"
import { extensions, modelProviders } from "@pi-cloud/runner"
import { sandboxes } from "@pi-cloud/sandbox"
import { localSandboxes } from "@pi-cloud/sandbox-local"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

let deployment: LocalDeployment | undefined
let root: string | undefined
afterEach(async () => {
  await deployment?.stop()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  deployment = undefined
  root = undefined
})

const until = async (check: () => boolean, what: string) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe("the service API", () => {
  it("serves the directory, sessions and conversations as Chord objects", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-cloud-services-"))
    const faux = fauxProvider({ models: [{ id: "deep", reasoning: true }, { id: "plain" }] })
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("subagent", { task: "count the files" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("There are three files."),
      fauxAssistantMessage("Three files.")
    ])
    deployment = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      runner: {
        idleMs: 2_000,
        plugins: [
          modelProviders(faux.provider),
          extensions("coding", CodingTools),
          piAgent(),
          sandboxes({ providers: [localSandboxes({ root })] })
        ]
      }
    })
    const connection = await connectServices({ url: deployment.url })
    try {
      // The directory lives on the control plane's host.
      const directory = await connection.sessions()
      const created = await directory.create({
        title: "demo",
        spec: { model: { provider: "faux", modelId: "deep" }, sandbox: "home", sandboxes: { home: { provider: "local" } } }
      })
      await until(() => directory.sessions.value.some((session) => session.id === created.id), "the directory")
      expect(directory.sessions.value.find((session) => session.id === created.id)?.title).toBe("demo")

      // The session and its conversations live on its runner, woken by the first reference.
      const session = await connection.session(created.id)
      const main = await connection.conversation(created.id)
      expect(main.configuration.value.model).toEqual({ provider: "faux", modelId: "deep" })
      expect(session.models.value.availableModels.map((model) => model.modelId).sort()).toEqual(["deep", "plain"])

      const response = await main.prompt({ message: "delegate it" })
      expect(response.accepted).toBe(true)
      const result = await main.waitForPrompt({ operationId: response.accepted ? response.operationId : "" })
      expect(result).toEqual({ status: "done", text: "Three files." })

      // The view is Pi Durable's, replicated; the subagent is another conversation, listed by the session.
      const entries = () => (main.view.value as ConversationView).entries
      await until(() => entries().some((entry) => entry.kind === "pi.assistant"), "the transcript")
      await until(() => session.conversations.value.length === 2, "the subagent's conversation")
      const listed = session.conversations.value.find((conversation) => conversation.id !== 1)!
      expect(listed).toMatchObject({ label: expect.stringMatching(/^subagent \d+$/), title: "count the files" })
      const subagent = await connection.conversation(created.id, listed.id)
      expect(JSON.stringify(subagent.view.value)).toContain("There are three files.")
      expect(session.tasks.value).toBeDefined()

      // Controls: thinking levels and model switching, clamped by the runner.
      await main.cycleThinking()
      await until(() => main.configuration.value.thinkingLevel !== "off", "a thinking level")
      await main.selectModel({ provider: "faux", modelId: "plain" })
      await until(() => main.configuration.value.model?.modelId === "plain", "the new model")
      expect(main.configuration.value.thinkingLevel).toBe("off")
      await expect(main.cycleThinking()).rejects.toThrow(/does not support thinking/)

      // Held references keep the runner; it stays past its idle time.
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      expect(directory.sessions.value.find((item) => item.id === created.id)?.runner.state).toBe("running")
      subagent.release()
      main.release()
      session.release()
    } finally {
      await connection.close()
    }
  }, 60_000)

  it("moves a presentation's references to a new runner when its runner dies", async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage("before"), fauxAssistantMessage("after")])
    deployment = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      settings: { leaseTtlMs: 1_500, recoveryIntervalMs: 250, attachTimeoutMs: 5_000 },
      runner: { idleMs: 5_000, plugins: [modelProviders(faux.provider)] }
    })
    const local = deployment
    const connection = await connectServices({ url: local.url })
    try {
      const directory = await connection.sessions()
      const created = await directory.create({ spec: { model: { provider: "faux", modelId: "faux-1" } } })
      const followed = await follow(() => connection.conversation(created.id))
      const first = await followed.current.prompt({ message: "one" })
      expect(await followed.current.waitForPrompt({ operationId: first.accepted ? first.operationId : "" })).toEqual({ status: "done", text: "before" })

      // The runner dies without releasing its lease. The control plane notices and the link to its host closes, so
      // the reference is gone; following it gets it again, which wakes a new runner with the same durable state.
      await local.runners.kill()
      const texts = () => {
        try {
          return JSON.stringify((followed.current.view.value as ConversationView).entries)
        } catch {
          return ""
        }
      }
      let second: Awaited<ReturnType<typeof followed.current.prompt>> | undefined
      for (let attempt = 0; attempt < 100 && second?.accepted !== true; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        second = await followed.current.prompt({ message: "two" }).catch(() => undefined)
      }
      expect(second?.accepted).toBe(true)
      await until(() => texts().includes("after"), "the answer from the new runner")
      expect(texts()).toContain("before")
      followed.release()
    } finally {
      await connection.close()
    }
  }, 60_000)
})
