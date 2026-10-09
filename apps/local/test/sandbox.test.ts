import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { entryText, PiCloud } from "@pi-cloud/client"
import { extensions, modelProviders } from "@pi-cloud/runner"
import { sandboxes } from "@pi-cloud/sandbox"
import { localSandboxes } from "@pi-cloud/sandbox-local"
import { Effect } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
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
})

const toolUse = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" })

describe("sandboxes", () => {
  it("lets the agent request a sandbox from a template and work inside it", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-cloud-sandboxes-"))
    // Something in the runner's own environment that must never reach a sandbox.
    process.env.PI_CLOUD_LEAK_CANARY = "canary-must-not-leak"
    const faux = fauxProvider()
    faux.setResponses([
      toolUse("bash", { command: "pwd" }),
      toolUse("sandbox_create", { template: "repo" }),
      toolUse("bash", { command: "cat README.md && echo $GREETING && printf %s \"$PI_CLOUD_TEST_SECRET\" > secret.txt" }),
      // A prompt-injected agent tries to exfiltrate: the environment holds only what the template granted, and the
      // granted secret comes back masked.
      toolUse("bash", { command: "env; echo token=$PI_CLOUD_TEST_SECRET" }),
      fauxAssistantMessage("All done")
    ])
    deployment = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      runner: {
        idleMs: 5_000,
        secrets: async (name) => (name === "PI_CLOUD_TEST_SECRET" ? "s3cret-value" : undefined),
        plugins: [
          modelProviders(faux.provider),
          extensions("coding", CodingTools),
          sandboxes({ providers: [localSandboxes({ root })] })
        ]
      }
    })
    const local = deployment

    const program = Effect.gen(function*() {
      const client = yield* PiCloud
      const session = yield* client.sessions.create({
        payload: {
          spec: {
            model: { provider: "faux", modelId: "faux-1" },
            sandboxes: {
              repo: {
                provider: "local",
                setup: ["echo 'project readme' > README.md"],
                env: { GREETING: "hello from the template" },
                secrets: ["PI_CLOUD_TEST_SECRET"]
              }
            }
          }
        }
      })
      const submitted = yield* client.sessions.submit({ params: { id: session.id }, payload: { content: "Go" } })
      while (true) {
        const record = yield* client.sessions.submission({
          params: { id: session.id, submissionId: submitted.submissionId }
        })
        if ((record as { status?: string } | null)?.status === "done") break
        yield* Effect.sleep(100)
      }
      const { entries } = yield* client.sessions.entries({ params: { id: session.id }, query: { limit: 1000 } })
      const results = entries.filter((entry: any) => entry.kind === "pi.tool-result").map((entry) => entryText(entry as never))

      // Before a sandbox exists, file and shell tools have nowhere to run.
      expect(results[0]).toMatch(/environment/i)
      expect(results[1]).toContain("ready and active")
      expect(results[2]).toContain("project readme")
      expect(results[2]).toContain("hello from the template")

      expect(results[3]).toContain("token=[secret:PI_CLOUD_TEST_SECRET]")
      expect(results[3]).toContain("GREETING=hello from the template")
      expect(results[3]).not.toContain("canary-must-not-leak")
      expect(results[3]).not.toContain("ANTHROPIC")

      // The secret reached the sandbox, but never the transcript.
      const secret = yield* Effect.promise(() => readFile(join(root!, `${session.id}_repo`, "secret.txt"), "utf8"))
      expect(secret).toBe("s3cret-value")
      expect(JSON.stringify(entries)).not.toContain("s3cret-value")
    })

    await Effect.runPromise(program.pipe(Effect.provide(PiCloud.layer({ url: local.url }))))
  }, 30_000)
})
