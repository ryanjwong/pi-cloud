import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import type { ConversationView, LiveState } from "@earendil-works/pi-durable"
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
      runner: {
        idleMs: 2_000,
        plugins: [
          modelProviders(faux.provider),
          extensions("coding", CodingTools),
          piAgent(),
          sandboxes({ providers: [localSandboxes({ root })] })
        ]
      },
      settings: { templates: { home: { provider: "local" } } }
    })
    const connection = await connectServices(deployment)
    try {
      const directory = await connection.sessions()
      const created = await directory.create({
        title: "demo",
        spec: { model: { provider: "faux", modelId: "deep" }, sandbox: "home" }
      })
      await until(() => directory.sessions.value.some((session) => session.id === created.id), "the directory")
      expect(directory.sessions.value.find((session) => session.id === created.id)?.title).toBe("demo")

      const session = await connection.session(created.id)
      const main = await connection.conversation(created.id)
      expect(main.configuration.value.model).toEqual({ provider: "faux", modelId: "deep" })
      expect(session.models.value.availableModels.map((model) => model.modelId).sort()).toEqual(["deep", "plain"])

      const response = await main.prompt({ message: "delegate it" })
      expect(response.accepted).toBe(true)
      const result = await main.waitForPrompt({ operationId: response.accepted ? response.operationId : "" })
      expect(result).toEqual({ status: "done", text: "Three files." })

      const entries = () => (main.view.value as ConversationView).entries
      await until(() => entries().some((entry) => entry.kind === "pi.assistant"), "the transcript")
      await until(() => session.conversations.value.length === 2, "the subagent's conversation")
      const listed = session.conversations.value.find((conversation) => conversation.id !== 1)!
      expect(listed).toMatchObject({ label: expect.stringMatching(/^subagent \d+$/), title: "count the files" })
      const subagent = await connection.conversation(created.id, listed.id)
      expect(JSON.stringify(subagent.view.value)).toContain("There are three files.")
      expect(session.tasks.value).toBeDefined()

      await main.cycleThinking()
      await until(() => main.configuration.value.thinkingLevel !== "off", "a thinking level")
      await main.selectModel({ provider: "faux", modelId: "plain" })
      await until(() => main.configuration.value.model?.modelId === "plain", "the new model")
      expect(main.configuration.value.thinkingLevel).toBe("off")
      await expect(main.cycleThinking()).rejects.toThrow(/does not support thinking/)

      await new Promise((resolve) => setTimeout(resolve, 3_000))
      expect(directory.sessions.value.find((item) => item.id === created.id)?.runner.state).toBe("running")
      subagent.release()
      main.release()
      session.release()
    } finally {
      await connection.close()
    }
  }, 60_000)

  it("streams an answer into the view before committing it", async () => {
    const faux = fauxProvider({ tokensPerSecond: 50 })
    faux.setResponses([fauxAssistantMessage(Array.from({ length: 40 }, (_, index) => `w${index}`).join(" "))])
    deployment = await startLocal({
      runner: { idleMs: 2_000, settings: { progress: { partialIntervalMs: 60_000 } }, plugins: [modelProviders(faux.provider)] }
    })
    const connection = await connectServices(deployment)
    try {
      const created = await (await connection.sessions()).create({ spec: { model: { provider: "faux", modelId: "faux-1" } } })
      const main = await connection.conversation(created.id)
      const view = () => main.view.value as ConversationView
      const streamed = () => JSON.stringify((view().docs["pi.live"] as LiveState | undefined)?.generation?.message ?? null)
      const response = await main.prompt({ message: "go" })
      await until(() => streamed().includes("w2 "), "streamed text")
      expect(view().entries.some((entry) => entry.kind === "pi.assistant")).toBe(false)
      expect(await main.waitForPrompt({ operationId: response.accepted ? response.operationId : "" })).toMatchObject({ status: "done" })
      await until(() => streamed() === "null" && view().entries.some((entry) => entry.kind === "pi.assistant"), "the committed answer")
      main.release()
    } finally {
      await connection.close()
    }
  }, 30_000)

  it("moves a presentation's references to a new runner when its runner dies", async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage("before"), fauxAssistantMessage("after")])
    deployment = await startLocal({
      settings: { leaseTtlMs: 1_500, recoveryIntervalMs: 250, attachTimeoutMs: 5_000 },
      runner: { idleMs: 5_000, plugins: [modelProviders(faux.provider)] }
    })
    const local = deployment
    const connection = await connectServices(local)
    try {
      const directory = await connection.sessions()
      const created = await directory.create({ spec: { model: { provider: "faux", modelId: "faux-1" } } })
      const followed = await follow(() => connection.conversation(created.id))
      const first = await followed.current.prompt({ message: "one" })
      expect(await followed.current.waitForPrompt({ operationId: first.accepted ? first.operationId : "" })).toEqual({ status: "done", text: "before" })

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
