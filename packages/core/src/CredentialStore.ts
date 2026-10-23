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

const PREFIX_LENGTH = "gcm:00000000:".length

const decrypt = (key: Buffer, bytes: Buffer, aad?: string): StoredCredential => {
  if (bytes.length < 28) throw new Error("Credential entry is truncated")
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12), { authTagLength: 16 })
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"))
}

export const credentialSealer = (secrets: ReadonlyArray<string>) => {
  if (secrets.length === 0) throw new Error("Set PI_CLOUD_CREDENTIAL_KEY to store credentials")
  const keys = new Map<string, Buffer>(secrets.map((secret) => {
    const key = createHash("sha256").update(secret).digest()
    return [`gcm:${createHash("sha256").update(key).digest("hex").slice(0, 8)}:`, key] as const
  }))
  const [primary, primaryKey] = [...keys][0]!
  const legacy = (stored: string): StoredCredential => {
    if (stored.startsWith("plain:")) return JSON.parse(stored.slice("plain:".length))
    const bytes = Buffer.from(stored.slice("aes256gcm:".length), "base64")
    for (const key of keys.values()) {
      try {
        return decrypt(key, bytes)
      } catch {
        continue
      }
    }
    throw new Error("No credential key opens this legacy entry")
  }
  const seal = (providerId: string, value: StoredCredential): string => {
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", primaryKey, iv).setAAD(Buffer.from(providerId))
    const sealed = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()])
    return `${primary}${Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64")}`
  }
  const open = (providerId: string, stored: string): StoredCredential => {
    const key = keys.get(stored.slice(0, PREFIX_LENGTH))
    if (key === undefined) {
      throw new Error(stored.startsWith("gcm:") ? "No configured credential key opens this entry" : "Unencrypted or legacy credential entries are refused")
    }
    return decrypt(key, Buffer.from(stored.slice(PREFIX_LENGTH), "base64"), providerId)
  }
  return {
    seal,
    open,
    migrate: (providerId: string, stored: string): string | undefined =>
      stored.startsWith(primary) ? undefined : seal(providerId, stored.startsWith("gcm:") ? open(providerId, stored) : legacy(stored))
  }
}
