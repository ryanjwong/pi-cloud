import { CredentialStore } from "@pi-cloud/core"
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node"
import { Effect, Option } from "effect"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { sqliteStores } from "../src/node.ts"

const secret = { type: "oauth" as const, access: "access-token-value", refresh: "refresh-token-value", expires: 1 }

const withFile = async (run: (file: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-credentials-"))
  try {
    await run(join(dir, "credentials.sqlite"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const using = (file: string) => <A>(keys: ReadonlyArray<string>, effect: Effect.Effect<A, unknown, CredentialStore>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(sqliteStores({ file, credentialKeys: keys }).credentials))))

const legacy = (secretKey: string, value: unknown) => {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secretKey).digest(), iv)
  const sealed = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()])
  return `aes256gcm:${Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64")}`
}

const raw = async (file: string) => Buffer.concat([await readFile(file), await readFile(`${file}-wal`).catch(() => Buffer.alloc(0))])

describe("sqliteCredentials", () => {
  it("seals credentials at rest in a private file and writes compare-and-swap", () =>
    withFile(async (file) => {
      const use = using(file)
      await use(["k1"], Effect.gen(function*() {
        const store = yield* CredentialStore
        expect(yield* store.put("openai-codex", secret, 0)).toEqual({ stored: true, version: 1 })
        expect(yield* store.put("openai-codex", { ...secret, access: "stale" }, 0)).toEqual({ stored: false, version: 1 })
        expect(yield* store.put("openai-codex", { ...secret, access: "fresh" }, 1)).toEqual({ stored: true, version: 2 })
      }))
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect((await raw(file)).includes(Buffer.from("refresh-token-value"))).toBe(false)
      const reopened = await use(["k1"], Effect.flatMap(CredentialStore, (store) => store.get("openai-codex")))
      expect(Option.getOrThrow(reopened)).toMatchObject({ version: 2, credential: { access: "fresh" } })
      await expect(use(["other"], Effect.flatMap(CredentialStore, (store) => store.get("openai-codex")))).rejects.toThrow(/No configured credential key/)
    }))

  it("migrates plain entries once at startup, then refuses plain entries", () =>
    withFile(async (file) => {
      const use = using(file)
      await use(["k1"], Effect.void)
      const db = await openNodeSqliteDatabase(file)
      const plant = () => db.run("INSERT OR REPLACE INTO credentials (provider_id, sealed, version, updated_at) VALUES (?, ?, 1, 0)", "anthropic", `plain:${JSON.stringify(secret)}`)
      await plant()
      const migrated = await use(["k1"], Effect.flatMap(CredentialStore, (store) => store.get("anthropic")))
      expect(Option.getOrThrow(migrated).credential).toEqual(secret)
      expect((await db.get<{ sealed: string }>("SELECT sealed FROM credentials"))?.sealed).toMatch(/^gcm:/)
      const refused = await use(["k1"], Effect.gen(function*() {
        const store = yield* CredentialStore
        yield* Effect.promise(plant)
        return yield* Effect.flip(store.get("anthropic"))
      }))
      expect(refused).toMatchObject({ _tag: "StorageFailure", message: expect.stringMatching(/refused/) })
      await db.close()
    }))

  it("reseals legacy entries with any configured key and leaves unopenable ones for reads to refuse", () =>
    withFile(async (file) => {
      const use = using(file)
      await use(["k1"], Effect.void)
      const db = await openNodeSqliteDatabase(file)
      const insert = (provider: string, sealed: string) =>
        db.run("INSERT INTO credentials (provider_id, sealed, version, updated_at) VALUES (?, ?, 1, 0)", provider, sealed)
      await insert("anthropic", legacy("k0", secret))
      await insert("openai-codex", legacy("lost", secret))
      const [opened, refused] = await use(["k1", "k0"], Effect.gen(function*() {
        const store = yield* CredentialStore
        return [yield* store.get("anthropic"), yield* Effect.flip(store.get("openai-codex"))] as const
      }))
      expect(Option.getOrThrow(opened).credential).toEqual(secret)
      expect(refused).toMatchObject({ _tag: "StorageFailure" })
      const rows = await db.all<{ provider_id: string; sealed: string }>("SELECT provider_id, sealed FROM credentials ORDER BY provider_id")
      expect(rows.map((row) => row.sealed.slice(0, 4))).toEqual(["gcm:", "aes2"])
      await db.close()
    }))
})
