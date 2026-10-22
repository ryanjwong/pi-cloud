import type { StoredCredential, StorageFailure } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Option } from "effect"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

export interface VersionedCredential {
  readonly providerId: string
  readonly credential: StoredCredential
  readonly version: number
  readonly updatedAt: number
}

export class CredentialStore extends Context.Service<CredentialStore, {
  get(providerId: string): Effect.Effect<Option.Option<VersionedCredential>, StorageFailure>
  list(): Effect.Effect<ReadonlyArray<VersionedCredential>, StorageFailure>
  put(
    providerId: string,
    credential: StoredCredential,
    expectedVersion?: number
  ): Effect.Effect<{ readonly stored: boolean; readonly version: number }, StorageFailure>
  remove(providerId: string): Effect.Effect<void, StorageFailure>
}>()("@pi-cloud/core/CredentialStore") {
  static readonly memory: Layer.Layer<CredentialStore> = Layer.sync(CredentialStore, () => {
    const entries = new Map<string, VersionedCredential>()
    return CredentialStore.of({
      get: (providerId) => Effect.sync(() => Option.fromUndefinedOr(entries.get(providerId))),
      list: () => Effect.sync(() => [...entries.values()]),
      put: (providerId, credential, expectedVersion) =>
        Effect.sync(() => {
          const current = entries.get(providerId)?.version ?? 0
          if (expectedVersion !== undefined && expectedVersion !== current) return { stored: false, version: current }
          entries.set(providerId, { providerId, credential, version: current + 1, updatedAt: Date.now() })
          return { stored: true, version: current + 1 }
        }),
      remove: (providerId) => Effect.sync(() => void entries.delete(providerId))
    })
  })
}

export const credentialSealer = (secret: string | undefined) => {
  const key = secret === undefined ? undefined : createHash("sha256").update(secret).digest()
  return {
    encrypted: key !== undefined,
    seal(value: StoredCredential): string {
      const json = JSON.stringify(value)
      if (key === undefined) return `plain:${json}`
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      const sealed = Buffer.concat([cipher.update(json, "utf8"), cipher.final()])
      return `aes256gcm:${Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64")}`
    },
    open(stored: string): StoredCredential {
      if (stored.startsWith("plain:")) return JSON.parse(stored.slice("plain:".length))
      if (key === undefined) throw new Error("Credentials are encrypted; set the credential key to read them")
      const bytes = Buffer.from(stored.slice("aes256gcm:".length), "base64")
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"))
    }
  }
}
