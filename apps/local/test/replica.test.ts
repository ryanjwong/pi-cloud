import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import { type ConversationView, StorageRequestError } from "@earendil-works/pi-durable"
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite"
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node"
import { registerStorageConformance } from "@earendil-works/pi-durable/testing"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { connectServices, follow } from "@pi-cloud/client"
import { piAgent } from "@pi-cloud/pi"
import { extensions, modelProviders, RemoteStorage, ReplicatedStorage, StorageBackendError } from "@pi-cloud/runner"
import { memoryReplica } from "@pi-cloud/runner/node"
import { dumpSqlite } from "@pi-cloud/storage-sqlite"
import { sqliteStores } from "@pi-cloud/storage-sqlite/node"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

registerStorageConformance({ describe, expect, it }, "ReplicatedStorage over SQLite", async (use) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-replica-"))
  const db = await openNodeSqliteDatabase(join(dir, "pi-cloud.sqlite"))
  const prefix = "s_test_"
  const backend = await SqliteStorage.open(db, { prefix })
  const remote = new RemoteStorage(async (method, args) => {
    const decoded = JSON.parse(JSON.stringify(args)).map((arg: unknown) => arg === null ? undefined : arg)
    try {
      const result = await (backend as any)[method](...decoded, BACKGROUND_CONTEXT)
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result))
    } catch (error) {
      if (error instanceof StorageRequestError) throw new StorageRequestError(error.message)
      throw new StorageBackendError(error instanceof Error ? error.message : String(error))
    }
  })
  const drops: Array<string> = []
  const storage = await ReplicatedStorage.open(remote, await dumpSqlite(db, prefix), memoryReplica, (reason) => drops.push(reason))
  try {
    if (!storage.replicated) throw new Error("The replica did not load")
    await use(storage)
    if (drops.length > 0) throw new Error(`The replica was dropped: ${drops.join("; ")}`)
  } finally {
    await storage.close(BACKGROUND_CONTEXT)
    await backend.close(BACKGROUND_CONTEXT)
    await rm(dir, { recursive: true, force: true })
  }
})

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

describe("read replicas", () => {
  it("keep a session's runners reading locally through subagents, tools and a crash", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-cloud-replica-e2e-"))
    const warnings: Array<string> = []
    const warn = console.warn
    console.warn = (...args: Array<unknown>) => void warnings.push(args.map(String).join(" "))
    try {
      const faux = fauxProvider()
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("subagent", { task: "look around" }), { stopReason: "toolUse" }),
        fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Looked."),
        fauxAssistantMessage("First answer."),
        fauxAssistantMessage("Second answer.")
      ])
      deployment = await startLocal({
        port: 41_000 + Math.floor(Math.random() * 10_000),
        settings: { leaseTtlMs: 1_500, recoveryIntervalMs: 250, attachTimeoutMs: 5_000 },
        ...sqliteStores({ file: join(root, "pi-cloud.sqlite"), credentialKeys: ["test-key"] }),
        runner: {
          idleMs: 5_000,
          replica: memoryReplica,
          plugins: [modelProviders(faux.provider), extensions("coding", CodingTools), piAgent()]
        }
      })
      const local = deployment
      const connection = await connectServices(local)
      try {
        const created = await (await connection.sessions()).create({ spec: { model: { provider: "faux", modelId: "faux-1" } } })
        const main = await follow(() => connection.conversation(created.id))
        const first = await main.current.prompt({ message: "one" })
        expect(await main.current.waitForPrompt({ operationId: first.accepted ? first.operationId : "" }))
          .toEqual({ status: "done", text: "First answer." })

        await local.runners.kill()
        const texts = () => {
          try {
            return JSON.stringify((main.current.view.value as ConversationView).entries)
          } catch {
            return ""
          }
        }
        let second: Awaited<ReturnType<typeof main.current.prompt>> | undefined
        for (let attempt = 0; attempt < 100 && second?.accepted !== true; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 200))
          second = await main.current.prompt({ message: "two" }).catch(() => undefined)
        }
        expect(second?.accepted).toBe(true)
        await until(() => texts().includes("Second answer."), "the answer from the new runner")
        expect(texts()).toContain("First answer.")
        main.release()
      } finally {
        await connection.close()
      }
      expect(warnings.filter((warning) => warning.includes("replica"))).toEqual([])
    } finally {
      console.warn = warn
    }
  }, 60_000)
})
