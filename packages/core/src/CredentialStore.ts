import type { StoredCredential, StorageFailure } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Option } from "effect"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

/** A stored credential with its version: 1 for the first write, then one more for every replacement. */
export interface VersionedCredential {
  readonly providerId: string
  readonly credential: StoredCredential
  readonly version: number
  readonly updatedAt: number
}

/**
 * Model provider credentials (API keys and subscription logins), shared by every runner. Writes are
 * compare-and-swap on `version`, so two runners refreshing the same OAuth token cannot lose one another's tokens.
 */
export class CredentialStore extends Context.Service<CredentialStore, {
  get(providerId: string): Effect.Effect<Option.Option<VersionedCredential>, StorageFailure>
  list(): Effect.Effect<ReadonlyArray<VersionedCredential>, StorageFailure>
  /**
   * Store `credential` if the current version is `expectedVersion` (0: none stored), or unconditionally without
   * one. Returns whether it was stored and the version now current.
   */
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

/**
 * Seals credentials at rest with AES-256-GCM under a key derived from `secret` (e.g. `PI_CLOUD_CREDENTIAL_KEY`,
 * from SOPS). Without a secret, values are stored as plain JSON.
 */
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
