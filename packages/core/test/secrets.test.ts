import { secretsEqual } from "@pi-cloud/protocol"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { credentialSealer } from "../src/CredentialStore.ts"

const credential = fc.oneof(
  fc.record({ type: fc.constant("api_key" as const), key: fc.string() }, { requiredKeys: ["type"] }),
  fc.record({ type: fc.constant("oauth" as const), refresh: fc.string(), access: fc.string(), expires: fc.integer({ min: 0 }) })
)

describe("secretsEqual", () => {
  it("agrees with ===, including near misses: prefixes, same lengths, unicode", () => {
    const near = fc.string({ minLength: 1 }).chain((a) =>
      fc.oneof(
        fc.constant([a, a]),
        fc.constant([a, a.slice(0, -1)]),
        fc.constant([a, `${a}x`]),
        fc.integer({ min: 0, max: a.length - 1 }).map((index) => [a, `${a.slice(0, index)}${a[index] === "z" ? "y" : "z"}${a.slice(index + 1)}`]),
        fc.string().map((b) => [a, b])
      )
    )
    fc.assert(fc.property(near, ([a, b]) => {
      expect(secretsEqual(a!, b!)).toBe(a === b)
    }), { numRuns: 5_000 })
    fc.assert(fc.property(fc.string({ unit: "grapheme" }), fc.string({ unit: "grapheme" }), (a, b) => {
      expect(secretsEqual(a, b)).toBe(a === b)
    }))
  })
})

describe("credentialSealer", () => {
  it("opens what it seals, and never stores the credential in the clear", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), credential, (key, value) => {
        const sealer = credentialSealer(key)
        const sealed = sealer.seal(value)
        expect(sealer.open(sealed)).toEqual(value)
        expect(sealer.seal(value)).not.toBe(sealed)
        for (const field of Object.values(value)) if (typeof field === "string" && field.length >= 4) expect(sealed).not.toContain(field)
      })
    )
  })

  it("refuses anything tampered with, or sealed under another key", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), credential, fc.nat(), fc.integer({ min: 1, max: 255 }), (key, other, value, at, flip) => {
        fc.pre(key !== other)
        const sealed = credentialSealer(key).seal(value)
        const bytes = Buffer.from(sealed.slice("aes256gcm:".length), "base64")
        bytes[at % bytes.length] = bytes[at % bytes.length]! ^ flip
        expect(() => credentialSealer(key).open(`aes256gcm:${bytes.toString("base64")}`)).toThrow(/unable to authenticate/)
        expect(() => credentialSealer(other).open(sealed)).toThrow(/unable to authenticate/)
        expect(() => credentialSealer(undefined).open(sealed)).toThrow(/encrypted/)
      })
    )
  })
})
