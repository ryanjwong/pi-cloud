import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node"
import { loadDump } from "@pi-cloud/runner"
import { dumpSqlite, sessionPrefix } from "@pi-cloud/storage-sqlite"
import fc from "fast-check"
import { describe, expect, it } from "vitest"

type Type = "INTEGER" | "REAL" | "TEXT" | "BLOB"
const valueOf: Record<Type, fc.Arbitrary<unknown>> = {
  INTEGER: fc.oneof(fc.integer(), fc.maxSafeInteger(), fc.constantFrom(0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER)),
  REAL: fc.double({ noNaN: true, noDefaultInfinity: true }).filter((value) => !Object.is(value, -0)),
  TEXT: fc.oneof(fc.string({ unit: "grapheme" }), fc.constantFrom("", "'; DROP TABLE x; --", "a\u0000b", "\"quoted\"", "123")),
  BLOB: fc.uint8Array({ maxLength: 64 })
}
const table = fc.array(fc.constantFrom<Type>("INTEGER", "REAL", "TEXT", "BLOB"), { minLength: 1, maxLength: 4 }).chain((types) =>
  fc.record({
    types: fc.constant(types),
    name: fc.constantFrom("entries", "tasks", "docs_v2", "weird \"name\""),
    rows: fc.array(fc.tuple(...types.map((type) => fc.option(valueOf[type], { nil: null }))), { maxLength: 15 })
  })
)

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const columns = (types: ReadonlyArray<Type>) => types.map((type, index) => `c${index} ${type}`).join(", ")

describe("session dump", () => {
  it("reproduces exactly the session's tables, rows and types in a replica", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(table, { selector: (t) => t.name, minLength: 1, maxLength: 3 }), async (tables) => {
        const source = await openNodeSqliteDatabase(":memory:")
        const replica = await openNodeSqliteDatabase(":memory:")
        try {
          const prefix = sessionPrefix("ses_0123456789abcdef0123456789abcdef")
          for (const { name, types, rows } of tables) {
            await source.exec(`CREATE TABLE ${quote(prefix + name)} (${columns(types)})`)
            await source.exec(`CREATE INDEX ${quote(`${prefix}${name}_i`)} ON ${quote(prefix + name)} (c0)`)
            for (const row of rows) {
              await source.run(`INSERT INTO ${quote(prefix + name)} VALUES (${row.map(() => "?").join(", ")})`, ...(row as never[]))
            }
          }
          for (const other of ["ses_0123456789abcdef0123456789abcdee", "ses_0123456789abcdef0123456789abcdef_x", "x"]) {
            await source.exec(`CREATE TABLE ${quote(`${sessionPrefix(other)}entries`)} (c0 TEXT)`)
            await source.run(`INSERT INTO ${quote(`${sessionPrefix(other)}entries`)} VALUES (?)`, "not this session")
          }

          const dump = JSON.parse(JSON.stringify(await dumpSqlite(source, prefix)))
          await loadDump(replica, dump)

          const names = async (db: typeof source) =>
            (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")).map((row) => row.name)
          const created = tables.flatMap(({ name }) => [prefix + name, `${prefix}${name}_i`]).sort()
          expect(await names(replica)).toEqual(created)
          for (const { name, types } of tables) {
            const select = `SELECT ${types.map((_, index) => `c${index}, typeof(c${index}) AS t${index}`).join(", ")} FROM ${quote(prefix + name)} ORDER BY rowid`
            expect(await replica.all(select)).toEqual(await source.all(select))
          }
        } finally {
          await source.close()
          await replica.close()
        }
      }),
      { numRuns: 200 }
    )
  })
})
