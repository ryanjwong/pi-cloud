import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { SecretMask } from "../src/Mask.ts"

// Secrets are long enough to mask, and not part of the markers that replace them.
const secret = fc.string({ minLength: 6, maxLength: 16, unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-_+/=") })
  .filter((value) => !"[secret:S0][secret:S1][secret:S2]".includes(value))
const secrets = fc.uniqueArray(secret, { minLength: 1, maxLength: 3 })
/** Output that mixes the secrets into noise, split into chunks at arbitrary points, on two streams. */
const output = (values: ReadonlyArray<string>) =>
  fc.array(fc.oneof(fc.integer({ min: 0, max: values.length - 1 }).map((index) => values[index]!), fc.string({ maxLength: 12 })), { maxLength: 12 })
    .map((pieces) => pieces.join(""))
    .chain((text) =>
      fc.record({
        text: fc.constant(text),
        cuts: fc.uniqueArray(fc.integer({ min: 1, max: Math.max(1, text.length - 1) }), { maxLength: 8 }).map((cuts) => cuts.sort((a, b) => a - b)),
        streams: fc.array(fc.constantFrom("stdout" as const, "stderr" as const), { minLength: 10, maxLength: 10 })
      })
    )

const leaks = (text: string, values: ReadonlyArray<string>) => values.filter((value) => text.includes(value))

describe("SecretMask", () => {
  it("leaves no secret in a masked result, however the secrets sit in it", () => {
    fc.assert(
      fc.property(secrets.chain((values) => fc.tuple(fc.constant(values), output(values))), ([values, { text }]) => {
        const mask = new SecretMask()
        values.forEach((value, index) => mask.add(`S${index}`, value))
        const result = mask.deep({ output: [{ type: "text", text }], nested: { list: [text, 1, null] } })
        expect(leaks(JSON.stringify(result), values)).toEqual([])
      }),
      { numRuns: 2_000 }
    )
  })

  it("leaves no secret in streamed output, even split across chunks", async () => {
    await fc.assert(
      fc.asyncProperty(secrets.chain((values) => fc.tuple(fc.constant(values), output(values))), async ([values, { text, cuts, streams }]) => {
        const mask = new SecretMask()
        values.forEach((value, index) => mask.add(`S${index}`, value))
        // A command whose stdout is `text`, arriving in chunks, interleaved with stderr noise.
        const chunks = [0, ...cuts, text.length].flatMap((start, index, all) => (index === all.length - 1 ? [] : [text.slice(start, all[index + 1])]))
        const env = {
          exec: async (_command: string, options: Parameters<ExecutionEnv["exec"]>[1]) => {
            chunks.forEach((chunk, index) => {
              options?.onOutput?.(chunk, BACKGROUND_CONTEXT, { stream: "stdout" } as never)
              if (streams[index] === "stderr") options?.onOutput?.("·", BACKGROUND_CONTEXT, { stream: "stderr" } as never)
            })
            return { ok: true, value: { exitCode: 0 } }
          }
        } as unknown as ExecutionEnv
        const streamed = { stdout: "", stderr: "" }
        await mask.env(env).exec("cmd", { onOutput: (chunk, _context, info) => void (streamed[info.stream] += chunk) }, BACKGROUND_CONTEXT)
        expect(leaks(streamed.stdout, values)).toEqual([])
        // Nothing is lost: what streamed is the masked output.
        expect(streamed.stdout).toBe(mask.text(text))
      }),
      { numRuns: 2_000 }
    )
  })
})
