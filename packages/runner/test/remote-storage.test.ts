import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { MemoryStorage } from "@earendil-works/pi-durable"
import { registerStorageConformance } from "@earendil-works/pi-durable/testing"
import { describe, expect, it } from "vitest"
import { RemoteStorage } from "../src/RemoteStorage.ts"

/** RemoteStorage over a transport that behaves like the control plane: JSON both ways, null back to undefined. */
const remoteOver = (backend: MemoryStorage) =>
  new RemoteStorage(async (method, args) => {
    const decoded = JSON.parse(JSON.stringify(args)).map((arg: unknown) => arg === null ? undefined : arg)
    const result = await (backend as any)[method](...decoded, BACKGROUND_CONTEXT)
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result))
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
