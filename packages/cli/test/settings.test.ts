import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LOCAL_URL, paths, readSettings, resolveConnection, saveTarget, versionSkew, writePrivate } from "../src/settings.ts"

const hasSops = spawnSync("sops", ["--version"]).status === 0 && spawnSync("age-keygen", ["--help"]).error === undefined

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-cloud-settings-"))
  vi.stubEnv("XDG_CONFIG_HOME", home)
  vi.stubEnv("HOME", home)
  for (const name of ["PI_CLOUD_URL", "PI_CLOUD_API_KEY", "SOPS_AGE_KEY_FILE"]) vi.stubEnv(name, undefined)
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

  it("migrates a config from before targets by copying its secrets and the default sops age key", () => {
    const checkout = join(home, "checkout")
    const key = join(home, "sops", "age", "keys.txt")
    mkdirSync(checkout)
    mkdirSync(join(home, "sops", "age"), { recursive: true })
    const legacy = { secrets: join(checkout, "secrets.yaml"), sopsConfig: join(checkout, ".sops.yaml"), key }
    writeFileSync(legacy.secrets, "PI_CLOUD_API_KEYS: old-key\n")
    if (hasSops) {
      execFileSync("age-keygen", ["-o", key], { stdio: "ignore" })
      const recipient = readFileSync(key, "utf8").match(/public key: (age1\w+)/)![1]!
      writeFileSync(legacy.sopsConfig, `creation_rules:\n  - path_regex: .*\\.yaml$\n    age: ${recipient}\n`)
      execFileSync("sops", ["encrypt", "--in-place", legacy.secrets], { cwd: checkout, env: { ...process.env, SOPS_AGE_KEY_FILE: key } })
    } else {
      writeFileSync(key, "AGE-SECRET-KEY-1TEST\n")
      writeFileSync(legacy.sopsConfig, "creation_rules: []\n")
    }
    const before = Object.fromEntries(Object.entries(legacy).map(([name, file]) => [name, readFileSync(file, "utf8")]))
    writePrivate(paths().settings, JSON.stringify({ url: "https://old.example", sandboxProvider: "daytona", secretsFile: legacy.secrets }))
    chmodSync(paths().dir, 0o755)
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    readSettings()
    expect(stderr).toHaveBeenCalledOnce()
    stderr.mockRestore()
    expect(readSettings()).toEqual({ default: "cloudflare", targets: { cloudflare: { kind: "cloudflare", url: "https://old.example" } } })
    const { ageKey, dir, secrets, sopsConfig, settings } = paths()
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    for (const [name, file] of Object.entries({ secrets, sopsConfig, key: ageKey })) {
      expect(readFileSync(file, "utf8")).toBe(before[name])
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(readFileSync(legacy[name as keyof typeof legacy], "utf8")).toBe(before[name])
    }
    expect(statSync(settings).mode & 0o777).toBe(0o600)
    rmSync(key)
    if (hasSops) expect(resolveConnection()).toEqual({ url: "https://old.example", apiKey: "old-key" })
  })

  it("explains when an older config has no secrets file to migrate", () => {
    writePrivate(paths().settings, JSON.stringify({ url: "https://old.example" }))
    expect(() => resolveConnection()).toThrow(/older pi-cloud and has no secrets file to migrate/)
  })

  it("takes the URL and key from flags, then the environment, then the saved target", () => {
    saveTarget("cf", { kind: "cloudflare", url: "https://cf.example" })
    writeFileSync(paths().secrets, "not sops")
    expect(() => resolveConnection()).toThrow(/Could not decrypt/)
    vi.stubEnv("PI_CLOUD_API_KEY", "env-key")
    expect(resolveConnection()).toEqual({ url: "https://cf.example", apiKey: "env-key" })
    vi.stubEnv("PI_CLOUD_URL", "https://env.example")
    expect(resolveConnection().url).toBe("https://env.example")
    expect(resolveConnection("https://flag.example", "flag-key")).toMatchObject({ url: "https://flag.example", apiKey: "flag-key" })
    vi.stubEnv("PI_CLOUD_API_KEY", undefined)
    expect(resolveConnection().apiKey).toBeUndefined()
  })

  it("reads the local server's admin key only for a loopback URL", () => {
    writePrivate(paths().adminToken, "local-key\n")
    expect(resolveConnection()).toEqual({ url: LOCAL_URL, apiKey: "local-key" })
    expect(resolveConnection("http://[::1]:8787").apiKey).toBe("local-key")
    expect(resolveConnection("https://remote.example").apiKey).toBeUndefined()
  })

  it("points at a redeploy when a target this CLI deployed runs another build", () => {
    saveTarget("pi-cloud", { kind: "cloudflare", url: "https://a.example" })
    saveTarget("staging", { kind: "cloudflare", url: "https://b.example" })
    expect(versionSkew("https://a.example", "0.1.0", "0.1.0+abc1234")).toBe(
      "pi-cloud at https://a.example runs 0.1.0, this CLI is 0.1.0+abc1234: run `pi-cloud deploy cloudflare` (or `pi-cloud update`)"
    )
    expect(versionSkew("https://b.example", "0.1.0+0000000", "0.1.0+abc1234")).toContain("`pi-cloud deploy cloudflare --name staging`")
    expect(versionSkew("https://a.example", "0.1.0+abc1234", "0.1.0+abc1234")).toBeUndefined()
    expect(versionSkew("https://elsewhere.example", "0.1.0", "0.1.0+abc1234")).toBeUndefined()
  })
})
