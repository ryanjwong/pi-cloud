import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { paths, readSettings, resolveConnection, saveTarget, writePrivate } from "../src/settings.ts"

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-cloud-settings-"))
  vi.stubEnv("XDG_CONFIG_HOME", home)
  for (const name of ["PI_CLOUD_URL", "PI_CLOUD_API_KEY", "PI_CLOUD_SANDBOX_PROVIDER", "SOPS_AGE_KEY_FILE"]) vi.stubEnv(name, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe("settings", () => {
  it("keeps targets in a private file under $XDG_CONFIG_HOME/pi-cloud", () => {
    saveTarget("a", { kind: "cloudflare", url: "https://a.example" })
    saveTarget("b", { kind: "cloudflare", url: "https://b.example" })
    const { dir, settings } = paths()
    expect(dir).toBe(join(home, "pi-cloud"))
    expect(statSync(settings).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readSettings()).toEqual({
      default: "b",
      targets: { a: { kind: "cloudflare", url: "https://a.example" }, b: { kind: "cloudflare", url: "https://b.example" } }
    })
    saveTarget("a", { kind: "cloudflare", url: "https://a2.example" })
    expect(readSettings().default).toBe("b")
  })

  it("asks to migrate a config from before targets", () => {
    writePrivate(paths().settings, JSON.stringify({ url: "https://old.example", secretsFile: "secrets.yaml" }))
    expect(() => resolveConnection()).toThrow(/older pi-cloud/)
  })

  it("takes the URL and key from flags, then the environment, then the saved target", () => {
    saveTarget("cf", { kind: "cloudflare", url: "https://cf.example", sandboxProvider: "daytona" })
    writeFileSync(paths().secrets, "not sops")
    expect(() => resolveConnection()).toThrow(/Could not decrypt/)
    vi.stubEnv("PI_CLOUD_API_KEY", "env-key")
    expect(resolveConnection()).toEqual({ url: "https://cf.example", apiKey: "env-key", sandboxProvider: "daytona" })
    vi.stubEnv("PI_CLOUD_URL", "https://env.example")
    expect(resolveConnection().url).toBe("https://env.example")
    expect(resolveConnection("https://flag.example", "flag-key")).toMatchObject({ url: "https://flag.example", apiKey: "flag-key" })
    vi.stubEnv("PI_CLOUD_API_KEY", undefined)
    expect(resolveConnection().apiKey).toBeUndefined()
  })
})
