import { BindingStore } from "@pi-cloud/core"
import { Effect, Layer, Option } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { sqliteBindings, sqliteSessions } from "../src/index.ts"

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

describe("sqliteBindings", () => {
  it("stores, filters, updates and removes bindings, and keeps them across reopening", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-cloud-bindings-"))
    const file = join(dir, "sessions.sqlite")
    // Shares its file with the session store, as the local servers do.
    const layer = Layer.merge(sqliteBindings({ file }), sqliteSessions({ file }))
    const use = <A>(f: (store: BindingStore["Service"]) => Effect.Effect<A, unknown>) =>
      Effect.runPromise(BindingStore.use(f).pipe(Effect.provide(layer)) as Effect.Effect<A>)

    await use((store) =>
      Effect.gen(function*() {
        yield* store.put({ key: "github:a/b#1", sessionId: "s1", createdAt: 1 })
        yield* store.put({ key: "slack:T:C:1", sessionId: "s2", source: "slack", target: { channel: "C" }, delivered: 0, createdAt: 2 })
        yield* store.put({ key: "slack:T:C:1", sessionId: "s2", source: "slack", target: { channel: "C" }, delivered: 9, createdAt: 2 })
      })
    )
    await use((store) =>
      Effect.gen(function*() {
        expect((yield* store.list()).map((binding) => binding.key).sort()).toEqual(["github:a/b#1", "slack:T:C:1"])
        expect((yield* store.list("slack")).map((binding) => binding.key)).toEqual(["slack:T:C:1"])
        const slack = yield* store.get("slack:T:C:1")
        expect(Option.getOrUndefined(slack)).toMatchObject({ sessionId: "s2", delivered: 9, target: { channel: "C" } })
        yield* store.remove("github:a/b#1")
        expect(Option.isNone(yield* store.get("github:a/b#1"))).toBe(true)
      })
    )
  })
})
