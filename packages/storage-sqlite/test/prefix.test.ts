import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { sessionPrefix } from "../src/index.ts"

const hex = (length: number) => fc.string({ minLength: length, maxLength: length, unit: fc.constantFrom(..."0123456789abcdef") })
const id = fc.oneof(
  fc.string({ minLength: 1, maxLength: 12, unit: fc.constantFrom("a", "b", "s", "e", "u", "x", "h", "_", "-", ".", "%", "é", "1", "😀") }),
  fc.string({ minLength: 1, maxLength: 40 }),
  hex(32).map((digits) => `ses_${digits}`),
  fc.oneof(hex(31), hex(33), hex(32).map((digits) => digits.toUpperCase())).map((digits) => `ses_${digits}`),
  hex(32).map((digits) => `ses_${digits}_u`)
)

describe("sessionPrefix", () => {
  it("keeps the table names of the ids pi-cloud mints", () => {
    expect(sessionPrefix("ses_0123456789abcdef0123456789abcdef")).toBe("s_ses_0123456789abcdef0123456789abcdef_")
  })

  it("keeps every session's tables apart: distinct ids never collide, and no prefix starts another", () => {
    fc.assert(
      fc.property(id, id, (a, b) => {
        fc.pre(a !== b)
        const [pa, pb] = [sessionPrefix(a), sessionPrefix(b)]
        expect(pa).not.toBe(pb)
        expect(pb.startsWith(pa)).toBe(false)
        expect(pa.startsWith(pb)).toBe(false)
        expect(pa).toMatch(/^[A-Za-z0-9_]+$/)
      }),
      { numRuns: 2_000 }
    )
  })
})
