import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { entryText, openChannel, PiCloud } from "@pi-cloud/client"
import { extensions, modelProviders } from "@pi-cloud/runner"
import { serveWorkspace } from "@pi-cloud/workspace"
import { workspace } from "@pi-cloud/workspace/plugin"
import { Effect } from "effect"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

const toolUse = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" })

describe("client workspaces", () => {
  it("runs the agent's tools in the client's checkout, waiting for the client to connect", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-cloud-ws-"))
    const checkout = join(root, "project", "app")
    await mkdir(checkout, { recursive: true })
    await writeFile(join(root, "project", "AGENTS.md"), "Always run the tests.\n")
    await writeFile(join(checkout, "README.md"), "hello from the checkout\n")

    const faux = fauxProvider()
    let prompt = ""
    faux.setResponses([
      (context) => {
        prompt = JSON.stringify(context)
        return toolUse("bash", { command: "cat README.md && pwd && echo made-by-agent > out.txt" })
      },
      toolUse("edit", { path: "README.md", edits: [{ oldText: "hello", newText: "edited" }] }),
      fauxAssistantMessage("Done")
    ])
    deployment = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      runner: { idleMs: 5_000, plugins: [modelProviders(faux.provider), extensions("coding", CodingTools), workspace()] }
    })
    const url = deployment.url

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* PiCloud
      const session = yield* client.sessions.create({
        payload: { spec: { model: { provider: "faux", modelId: "faux-1" }, workspace: { cwd: checkout, host: "laptop" } } }
      })
      // The prompt goes in before any client serves the workspace: the first tool call waits for one.
      const submitted = yield* client.sessions.submit({ params: { id: session.id }, payload: { content: "Go" } })
      yield* Effect.sleep(500)
      expect(yield* Effect.promise(() => readFile(join(checkout, "out.txt"), "utf8").catch(() => "missing"))).toBe("missing")

      const server = serveWorkspace(new NodeExecutionEnv({ cwd: checkout }))
      yield* openChannel({ url, sessionId: session.id, workspace: server })
      while (true) {
        const record = yield* client.sessions.submission({ params: { id: session.id, submissionId: submitted.submissionId } })
        if ((record as { status?: string } | null)?.status === "done") break
        yield* Effect.sleep(100)
      }
      const { entries } = yield* client.sessions.entries({ params: { id: session.id }, query: { limit: 1000 } })
      const results = entries.filter((entry: any) => entry.kind === "pi.tool-result").map((entry) => entryText(entry as never))

      expect(results[0]).toContain("hello from the checkout")
      expect(results[0]).toContain(checkout)
      expect(yield* Effect.promise(() => readFile(join(checkout, "out.txt"), "utf8"))).toBe("made-by-agent\n")
      expect(yield* Effect.promise(() => readFile(join(checkout, "README.md"), "utf8"))).toBe("edited from the checkout\n")
      // Project instructions are found the way Pi finds them: in the working directory and its parents.
      expect(prompt).toContain("Always run the tests.")
      expect(prompt).toContain(`working in ${checkout} on laptop`)
      yield* Effect.promise(() => server.close())
    })).pipe(Effect.provide(PiCloud.layer({ url }))))
  }, 30_000)

  it("cancels a running command on the client when the session is aborted", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-cloud-ws-"))
    const checkout = root
    const faux = fauxProvider()
    faux.setResponses([toolUse("bash", { command: "echo started > started.txt; sleep 5; echo late > late.txt" }), fauxAssistantMessage("Stopped")])
    deployment = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      runner: { idleMs: 5_000, plugins: [modelProviders(faux.provider), extensions("coding", CodingTools), workspace()] }
    })
    const url = deployment.url
    const exists = (name: string) => readFile(join(checkout, name), "utf8").then(() => true, () => false)

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const client = yield* PiCloud
      const session = yield* client.sessions.create({
        payload: { spec: { model: { provider: "faux", modelId: "faux-1" }, workspace: { cwd: checkout } } }
      })
      const channel = yield* openChannel({ url, sessionId: session.id, workspace: serveWorkspace(new NodeExecutionEnv({ cwd: checkout })) })
      yield* channel.command({ _tag: "Prompt", content: "Go" })
      while (!(yield* Effect.promise(() => exists("started.txt")))) yield* Effect.sleep(50)
      yield* channel.command({ _tag: "Abort" })
      yield* Effect.sleep(6_000)
      expect(yield* Effect.promise(() => exists("late.txt"))).toBe(false)
    })).pipe(Effect.provide(PiCloud.layer({ url }))))
  }, 30_000)
})
