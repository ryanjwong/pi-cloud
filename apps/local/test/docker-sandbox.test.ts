import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { entryText, PiCloud } from "@pi-cloud/client"
import { piAgent } from "@pi-cloud/pi"
import { extensions, modelProviders } from "@pi-cloud/runner"
import { sandboxes } from "@pi-cloud/sandbox"
import { dockerSandboxes } from "@pi-cloud/sandbox-docker"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

const docker = (...args: Array<string>) => execFileSync("docker", args, { stdio: "pipe" }).toString().trim()
const IMAGE = "buildpack-deps:bookworm-scm"
const available = (() => {
  try {
    docker("image", "inspect", IMAGE)
    return true
  } catch {
    return false
  }
})()

let deployment: LocalDeployment | undefined
const containers: Array<string> = []
afterEach(async () => {
  await deployment?.stop()
  deployment = undefined
  for (const container of containers.splice(0)) {
    try {
      docker("rm", "--force", container)
    } catch {
      // Already gone.
    }
  }
})

const toolUse = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" })

const waitFor = async <A>(check: () => Promise<A | undefined>): Promise<A> => {
  for (let attempt = 0; attempt < 600; attempt++) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("timed out")
}

describe.skipIf(!available)("Docker sandboxes", () => {
  it("runs Pi's tools in the session's container, with its AGENTS.md and only the granted secrets", async () => {
    process.env["PI_CLOUD_TEST_RUNNER_ONLY"] = "runner-only"
    const faux = fauxProvider()
    let prompt = ""
    faux.setResponses([
      (context) => {
        prompt = JSON.stringify(context)
        return toolUse("bash", {
          command: "grep ^ID= /etc/os-release; pwd; echo token=$API_TOKEN; echo runner=${PI_CLOUD_TEST_RUNNER_ONLY:-unset}"
        })
      },
      toolUse("write", { path: "notes/hello.txt", content: "hello from pi\n" }),
      toolUse("edit", { path: "notes/hello.txt", edits: [{ oldText: "hello", newText: "greetings" }] }),
      toolUse("read", { path: "notes/hello.txt" }),
      toolUse("bash", { command: "sleep 60", timeout: 1 }),
      fauxAssistantMessage("Done")
    ])
    deployment = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      runner: {
        idleMs: 5_000,
        secrets: async (name) => (name === "API_TOKEN" ? "tok_in_the_container" : undefined),
        plugins: [
          modelProviders(faux.provider),
          extensions("coding", CodingTools),
          piAgent(),
          sandboxes({ providers: [dockerSandboxes({ image: IMAGE })] })
        ]
      }
    })

    await Effect.runPromise(Effect.gen(function*() {
      const client = yield* PiCloud
      const session = yield* client.sessions.create({
        payload: {
          spec: {
            model: { provider: "faux", modelId: "faux-1" },
            sandbox: "box",
            sandboxes: {
              box: { provider: "docker", cwd: "app", secrets: ["API_TOKEN"], setup: ["printf 'Always answer in haiku.\\n' > AGENTS.md"] }
            }
          }
        }
      })
      const container = `pi-cloud-${session.id}-box`.toLowerCase()
      containers.push(container)
      yield* client.sessions.submit({ params: { id: session.id }, payload: { content: "Go" } })
      const entries = yield* Effect.promise(() =>
        waitFor(async () => {
          const { entries } = await Effect.runPromise(client.sessions.entries({ params: { id: session.id }, query: { limit: 1000 } }))
          return entries.some((entry: any) => entry.kind === "pi.assistant" && entryText(entry) === "Done") ? entries : undefined
        })
      )
      const results = entries.filter((entry: any) => entry.kind === "pi.tool-result").map((entry) => entryText(entry as never))

      // The container's own system, its working directory, the granted secret (masked), and nothing from the runner.
      expect(results[0]).toContain("ID=debian")
      expect(results[0]).toContain("/workspace/app")
      expect(results[0]).toContain("token=[secret:API_TOKEN]")
      expect(results[0]).toContain("runner=unset")
      expect(results[3]).toContain("greetings from pi")
      expect(results[4]).toMatch(/timed out|timeout/i)
      expect(JSON.stringify(entries)).not.toContain("tok_in_the_container")

      // Pi's system prompt read the AGENTS.md the setup wrote inside the container.
      expect(prompt).toContain("Always answer in haiku.")
      expect(prompt).toContain("/workspace/app/AGENTS.md")

      // The files live in the container, the timed-out command is gone, and the secret is not in its config.
      expect(docker("exec", container, "cat", "/workspace/app/notes/hello.txt")).toBe("greetings from pi")
      expect(docker("exec", container, "sh", "-c", "ps -eo args | grep -c '^sleep 60' || true")).toBe("0")
      expect(docker("inspect", container)).not.toContain("tok_in_the_container")
    }).pipe(Effect.provide(PiCloud.layer({ url: deployment.url }))))
  }, 60_000)
})
