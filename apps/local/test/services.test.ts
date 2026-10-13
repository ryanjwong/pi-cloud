import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import type { ConversationView } from "@earendil-works/pi-durable"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import {
  AgentController,
  CloudSessions,
  type Conversation,
  Conversations,
  connectServices,
  Models,
  Notices,
  SessionDirectory,
  Tasks,
  Transcript
} from "@pi-cloud/client"
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
  it("serves Pi's services and pi-cloud's through Pi's own client", async () => {
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
      // Server services: pi-cloud's sessions, and Pi's directory, live.
      const sessions = connection.server.use(CloudSessions)
      const directory = connection.server.use(SessionDirectory)
      await connection.server.ready(BACKGROUND_CONTEXT)
      const created = await sessions.create({
        title: "demo",
        spec: { model: { provider: "faux", modelId: "deep" }, sandbox: "home", sandboxes: { home: { provider: "local" } } }
      }, BACKGROUND_CONTEXT)
      await until(() => directory.state.value?.sessions.some((session) => session.sessionId === created.id) === true, "the directory")
      expect(sessions.state.value?.sessions.find((session) => session.id === created.id)?.title).toBe("demo")

      // Session services, served by the session's runner through the control plane.
      const attached = await connection.attach(created.id)
      const agent = attached.services.use(AgentController)
      const transcript = attached.services.use(Transcript)
      const models = attached.services.use(Models)
      const tasks = attached.services.use(Tasks)
      const notices = attached.services.use(Notices)
      const conversations = new Map<number, Conversation>()
      attached.services.observe(Conversations, (conversation) => {
        conversations.set(conversation.summary.value!.id, conversation)
      })
      await attached.services.ready(BACKGROUND_CONTEXT)
      expect(models.state.value?.configuration.model).toEqual({ provider: "faux", modelId: "deep" })
      expect(models.state.value?.catalog.availableModels.map((model) => model.modelId).sort()).toEqual(["deep", "plain"])

      const response = await agent.prompt({ message: "delegate it", images: null }, BACKGROUND_CONTEXT)
      expect(response.accepted).toBe(true)
      const result = await agent.waitForPrompt(response.operationId!, BACKGROUND_CONTEXT)
      expect(result).toEqual({ status: "done", text: "Three files.", reason: null })

      // The transcript is the root conversation's live view; the subagent is another conversation instance.
      const entries = () => (transcript.state.value as ConversationView | undefined)?.entries ?? []
      await until(() => entries().some((entry) => entry.kind === "pi.assistant"), "the transcript")
      await until(() => conversations.size === 2, "the subagent's conversation")
      const subagent = [...conversations.values()].find((conversation) => conversation.summary.value!.id !== 1)!
      expect(subagent.summary.value).toMatchObject({ label: expect.stringMatching(/^subagent \d+$/), title: "count the files" })
      expect(JSON.stringify(subagent.state.value)).toContain("There are three files.")
      expect(tasks.state.value).toBeDefined()

      // Controls go through the services too: thinking levels and model switching, clamped by the runner.
      await models.cycleThinking(BACKGROUND_CONTEXT)
      await until(() => models.state.value?.configuration.thinkingLevel !== "off", "a thinking level")
      await models.select({ provider: "faux", modelId: "plain" }, BACKGROUND_CONTEXT)
      await until(() => models.state.value?.configuration.model?.modelId === "plain", "the new model")
      expect(models.state.value?.configuration.thinkingLevel).toBe("off")
      await conversations.get(1)!.cycleThinking(BACKGROUND_CONTEXT)
      await until(() => notices.state.value?.notices.some((notice) => notice.message.includes("does not support thinking")) === true, "the notice")

      // An attached presentation keeps the runner; it stays past its idle time.
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      const view = sessions.state.value?.sessions.find((session) => session.id === created.id)
      expect(view?.runner.state).toBe("running")
      await attached.detach()
    } finally {
      await connection.close()
    }
  }, 60_000)

  it("moves an attached presentation to a new runner when its runner dies", async () => {
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
      const sessions = connection.server.use(CloudSessions)
      await connection.server.ready(BACKGROUND_CONTEXT)
      const created = await sessions.create({ title: null, spec: { model: { provider: "faux", modelId: "faux-1" } } }, BACKGROUND_CONTEXT)
      const attached = await connection.attach(created.id)
      const agent = attached.services.use(AgentController)
      const transcript = attached.services.use(Transcript)
      await attached.services.ready(BACKGROUND_CONTEXT)
      const first = await agent.prompt({ message: "one", images: null }, BACKGROUND_CONTEXT)
      expect((await agent.waitForPrompt(first.operationId!, BACKGROUND_CONTEXT)).text).toBe("before")

      // The runner dies without releasing its lease. The control plane notices, Pi's server ends the attachment,
      // and the client attaches again: on a new runner, with the same durable state.
      await local.runners.kill()
      const texts = () => JSON.stringify((transcript.state.value as ConversationView | undefined)?.entries ?? [])
      let second: Awaited<ReturnType<typeof agent.prompt>> | undefined
      for (let attempt = 0; attempt < 100 && second?.accepted !== true; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        second = await agent.prompt({ message: "two", images: null }, BACKGROUND_CONTEXT).catch(() => undefined)
      }
      expect(second?.accepted).toBe(true)
      await until(() => texts().includes("after"), "the answer from the new runner")
      expect(texts()).toContain("before")
      await attached.detach()
    } finally {
      await connection.close()
    }
  }, 60_000)
})
