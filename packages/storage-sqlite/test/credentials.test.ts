import { CredentialStore } from "@pi-cloud/core"
import { Effect, Option } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { sqliteStores } from "../src/node.ts"

describe("sqliteCredentials", () => {
  it("seals credentials at rest and writes compare-and-swap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cloud-credentials-"))
    const file = join(dir, "credentials.sqlite")
    const secret = { type: "oauth" as const, access: "access-token-value", refresh: "refresh-token-value", expires: 1 }
    const use = <A>(key: string | undefined, effect: Effect.Effect<A, unknown, CredentialStore>) =>
      Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(sqliteStores({ file, credentialKey: key }).credentials))))
    try {
      await use("k1", Effect.gen(function*() {
        const store = yield* CredentialStore
        expect(yield* store.put("openai-codex", secret, 0)).toEqual({ stored: true, version: 1 })
        expect(yield* store.put("openai-codex", { ...secret, access: "stale" }, 0)).toEqual({ stored: false, version: 1 })
        expect(yield* store.put("openai-codex", { ...secret, access: "fresh" }, 1)).toEqual({ stored: true, version: 2 })
      }))
      const raw = Buffer.concat([await readFile(file), await readFile(`${file}-wal`).catch(() => Buffer.alloc(0))])
      expect(raw.includes(Buffer.from("refresh-token-value"))).toBe(false)
      const reopened = await use("k1", Effect.flatMap(CredentialStore, (store) => store.get("openai-codex")))
      expect(Option.getOrThrow(reopened)).toMatchObject({ version: 2, credential: { access: "fresh" } })
      await expect(use("other", Effect.flatMap(CredentialStore, (store) => store.get("openai-codex")))).rejects.toThrow(/unable to authenticate/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
