import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { MemoryStorage, StorageRequestError } from "@earendil-works/pi-durable"
import { registerStorageConformance } from "@earendil-works/pi-durable/testing"
import { describe, expect, it } from "vitest"
import { RemoteStorage, StorageBackendError } from "../src/RemoteStorage.ts"

/**
 * RemoteStorage over a transport that behaves like the control plane: JSON both ways, null back to undefined, and
 * the backend's failures reported as such (request errors as Pi's `StorageRequestError`).
 */
const remoteOver = (backend: MemoryStorage) =>
  new RemoteStorage(async (method, args) => {
    const decoded = JSON.parse(JSON.stringify(args)).map((arg: unknown) => arg === null ? undefined : arg)
    try {
      const result = await (backend as any)[method](...decoded, BACKGROUND_CONTEXT)
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result))
    } catch (error) {
      if (error instanceof StorageRequestError) throw new StorageRequestError(error.message)
      throw new StorageBackendError(error instanceof Error ? error.message : String(error))
    }
  })

registerStorageConformance({ describe, expect, it }, "RemoteStorage over JSON", async (use) => {
  const backend = new MemoryStorage()
  const storage = remoteOver(backend)
  try {
    await use(storage)
  } finally {
    await storage.close(BACKGROUND_CONTEXT)
  }
})

describe("RemoteStorage retries", () => {
  it("retries transport failures, commits with one request id, and never retries the control plane's answers", async () => {
    const backend = new MemoryStorage()
    const seen: Array<{ method: string; requestId: string | undefined }> = []
    let failures = 2
    const storage = new RemoteStorage(async (method, args, requestId) => {
      seen.push({ method, requestId })
      if (failures-- > 0) throw new TypeError("fetch failed")
      if (method === "conversation") throw new StorageRequestError("no such conversation")
      const decoded = JSON.parse(JSON.stringify(args)).map((arg: unknown) => arg === null ? undefined : arg)
      const result = await (backend as any)[method](...decoded, BACKGROUND_CONTEXT)
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result))
    })
    await storage.commit([], BACKGROUND_CONTEXT)
    expect(seen.map((call) => call.method)).toEqual(["commit", "commit", "commit"])
    expect(new Set(seen.map((call) => call.requestId)).size).toBe(1)
    expect(seen[0]!.requestId).toBeDefined()

    seen.length = 0
    await expect(storage.conversation(7 as never, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(StorageRequestError)
    expect(seen).toHaveLength(1)
    await storage.close(BACKGROUND_CONTEXT)
  })
})
