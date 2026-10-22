import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { forwarded } from "../src/paths.ts"

/** Ways a server, proxy or router might read a path: each must agree that a forwarded path is public. */
const decodeAll = (path: string) => {
  let current = path
  for (let round = 0; round < 4; round++) {
    try {
      const next = decodeURIComponent(current)
      if (next === current) break
      current = next
    } catch {
      break
    }
  }
  return current
}
const removeDots = (path: string) => {
  const out: Array<string> = []
  for (const segment of path.split("/")) {
    if (segment === "..") out.pop()
    else if (segment !== ".") out.push(segment)
  }
  return out.join("/")
}
const readings = (path: string) => {
  const base = [path, decodeAll(path)]
  return base.flatMap((p) => {
    const slashes = p.replaceAll("\\", "/").replace(/\/{2,}/g, "/")
    const variants = [p, slashes, removeDots(slashes), removeDots(slashes).split(";")[0]!]
    return [...variants, ...variants.map((v) => v.toLowerCase())]
  })
}
const firstSegment = (path: string) => path.replace(/^\/+/, "").split("/")[0]!

const segment = fc.constantFrom(
  "v1", "internal", "INTERNAL", "Internal", "runner", "sessions", "pi", "health", "docs", "openapi.json", "", ".", "..",
  "%2e", "%2E%2E", "%2f", "%2F", "%5c", "%69nternal", "%2569nternal", "\\", "..\\internal", ";x", "v1;", "%00", "~", "x",
  // Traversals hidden inside one segment, for readers that decode before they split.
  "..%2f..%2finternal", "%2e%2e%2f%2e%2e%2finternal", "x%2f..%2f..%2finternal", "%252e%252e%252finternal", "..%5c..%5cinternal"
)
const rawPath = fc.array(segment, { minLength: 1, maxLength: 6 }).map((segments) => `/${segments.join("/")}`)

describe("the Worker's public paths", () => {
  it("never forwards a path that any reading of it puts outside the public API", () => {
    fc.assert(
      fc.property(rawPath, (raw) => {
        // What the Worker sees: the URL as the runtime parsed it.
        const path = new URL(`https://pi.example${raw}`).pathname
        if (!forwarded(path)) return
        for (const reading of readings(path)) {
          expect(firstSegment(reading), `${raw} read as ${reading}`).not.toMatch(/internal/i)
          expect(["v1", "health", "docs", "openapi.json"]).toContain(firstSegment(reading).toLowerCase())
        }
      }),
      { numRuns: 20_000 }
    )
  })

  it("forwards the public API", () => {
    for (const path of ["/health", "/docs", "/openapi.json", "/v1/pi", "/v1/server", "/v1/sessions", "/v1/sessions/ses_abc/channel", "/v1/triggers/github", "/v1/sources/slack", "/v1/credentials/anthropic"]) {
      expect(forwarded(path), path).toBe(true)
    }
    for (const path of ["/internal/runner", "/", "/v1", "/v1/", "/healthz", "/docs/../internal"]) expect(forwarded(path), path).toBe(false)
  })
})
