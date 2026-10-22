import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import { gitCredentialEnv } from "../src/Plugin.ts"

describe("git credential helper", () => {
  it("answers only for https://github.com", () => {
    const fill = (host: string) =>
      execFileSync("git", ["credential", "fill"], {
        input: `protocol=https\nhost=${host}\n\n`,
        env: { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: "1", ...gitCredentialEnv("TOKEN"), TOKEN: "t0ken" },
        stdio: "pipe"
      }).toString()
    expect(fill("github.com")).toContain("password=t0ken")
    expect(() => fill("evil.example")).toThrow(/terminal prompts disabled/)
  })
})
