import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeRenderer } from "../src/render.ts"
import { workerConfig } from "../src/setup.ts"

const main = resolve(import.meta.dirname, "../src/main.ts")
const home = mkdtempSync(join(tmpdir(), "pi-cloud-cli-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))

const cli = (args: ReadonlyArray<string>, cwd = home) => {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(home, "config") }
  for (const name of ["PI_CLOUD_URL", "PI_CLOUD_API_KEY", "SOPS_AGE_KEY_FILE"]) delete env[name]
  const result = spawnSync(process.execPath, [main, ...args], { cwd, env, input: "", encoding: "utf8", timeout: 30_000 })
  return { status: result.status, out: result.stdout + result.stderr }
}

describe("pi-cloud", () => {
  it("prints help without touching the network or the config", () => {
    const help = cli(["--help"])
    expect(help.status).toBe(0)
    expect(help.out).toContain("pi-cloud update")
    expect(cli(["--bogus"])).toMatchObject({ status: 1, out: expect.stringMatching(/^Unknown option '--bogus'/) })
    expect(cli(["nonsense"]).status).toBe(1)
  })

  it("reports an unreachable server in one line and exits 1", () => {
    for (const command of [["ls"], ["auth"], ["rm", "x"]]) {
      expect(cli([...command, "--url", "http://127.0.0.1:1"])).toEqual({ status: 1, out: "Can't reach pi-cloud at http://127.0.0.1:1.\n" })
    }
    expect(cli(["doctor", "--url", "http://127.0.0.1:1"])).toMatchObject({ status: 1, out: expect.stringContaining("✗ Can't reach") })
  })

  it("prints a failed turn and exits 1", () => {
    const output: Array<string> = []
    const before = process.exitCode
    makeRenderer((text) => void output.push(text))({
      type: "message_end",
      entry: { model: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "No API key for anthropic" }] }
    })
    expect(process.exitCode).toBe(1)
    process.exitCode = before
    expect(output.join("")).toContain("No API key for anthropic")
  })

  it("deploys the bundled Worker under the target's name, with append-only migrations", () => {
    const config = workerConfig("staging")
    expect(config.name).toBe("staging")
    expect(isAbsolute(config.main) && existsSync(config.main)).toBe(true)
    expect(config.migrations.slice(0, 1)).toEqual([{ tag: "v1", new_sqlite_classes: ["ControlPlane", "SessionHost"] }])
  })

  const hasSops = spawnSync("sops", ["--version"]).status === 0 && spawnSync("age-keygen", ["--help"]).error === undefined
  it.skipIf(!hasSops)("init writes only under the config directory, privately", () => {
    const repo = mkdtempSync(join(home, "repo-"))
    expect(cli(["init"], repo).status).toBe(0)
    expect(readdirSync(repo)).toEqual([])
    const dir = join(home, "config", "pi-cloud")
    expect(readdirSync(dir).sort()).toEqual([".sops.yaml", "age.key", "secrets.yaml"])
    for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600)
    expect(cli(["init"], repo).status).toBe(0)
  }, 30_000)
})
