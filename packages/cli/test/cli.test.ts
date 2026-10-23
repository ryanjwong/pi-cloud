import { execFile, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { makeRenderer } from "../src/render.ts"
import { workerConfig } from "../src/setup.ts"

const main = resolve(import.meta.dirname, "../src/main.ts")
const home = mkdtempSync(join(tmpdir(), "pi-cloud-cli-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))

const cliEnv = () => {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(home, "config") }
  for (const name of ["PI_CLOUD_URL", "PI_CLOUD_API_KEY", "SOPS_AGE_KEY_FILE"]) delete env[name]
  return env
}

const cli = (args: ReadonlyArray<string>, cwd = home) => {
  const result = spawnSync(process.execPath, [main, ...args], { cwd, env: cliEnv(), input: "", encoding: "utf8", timeout: 30_000 })
  return { status: result.status, out: result.stdout + result.stderr }
}

const cliAsync = (args: ReadonlyArray<string>) =>
  new Promise<{ status: number | null; out: string }>((done) => {
    const child = execFile(process.execPath, [main, ...args], { cwd: home, env: cliEnv(), encoding: "utf8", timeout: 30_000 }, (_error, stdout, stderr) =>
      done({ status: child.exitCode, out: stdout + stderr }))
    child.stdin?.end()
  })

describe("pi-cloud", { timeout: 30_000 }, () => {
  it("prints help without touching the network or the config", () => {
    const help = cli(["--help"])
    expect(help.status).toBe(0)
    expect(help.out).toContain("pi-cloud update")
    expect(cli(["--bogus"])).toMatchObject({ status: 1, out: expect.stringMatching(/^Unknown option '--bogus'/) })
    expect(cli(["nonsense"]).status).toBe(1)
  })

  it("reports an unreachable server in one line and exits 1", async () => {
    const [ls, auth, rm, doctor] = await Promise.all([["ls"], ["auth"], ["rm", "x"], ["doctor"]].map((command) => cliAsync([...command, "--url", "http://127.0.0.1:1"])))
    for (const result of [ls, auth, rm]) expect(result).toEqual({ status: 1, out: "Can't reach pi-cloud at http://127.0.0.1:1.\n" })
    expect(doctor).toMatchObject({ status: 1, out: expect.stringContaining("✗ Can't reach") })
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
    vi.stubEnv("PI_CLOUD_BUILD", "abc1234")
    expect(workerConfig("staging").define).toEqual({ PI_CLOUD_BUILD: '"abc1234"' })
    vi.unstubAllEnvs()
  })

  it("explains a refused session socket by the deployed target's other build, else keeps the socket error", async () => {
    let version = "0.1.0"
    const server = createServer((request, response) => {
      const body = request.url === "/v1/server"
        ? { version, servicesPath: "/v1/pi" }
        : { id: "ses_1", spec: {}, createdAt: 0, runner: { state: "idle" } }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body))
    })
    server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"))
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    mkdirSync(join(home, "config", "pi-cloud"), { recursive: true })
    writeFileSync(join(home, "config", "pi-cloud", "config.json"), JSON.stringify({ default: "pi-cloud", targets: { "pi-cloud": { kind: "cloudflare", url } } }))
    const attach = () =>
      new Promise<string>((done) => {
        const child = spawn(process.execPath, [main, "-r", "ses_1"], { cwd: home, env: { ...cliEnv(), PI_CLOUD_BUILD: "abc1234" } })
        let out = ""
        child.stdout.on("data", (chunk) => (out += chunk))
        child.stderr.on("data", (chunk) => (out += chunk))
        child.on("close", () => done(out))
      })
    try {
      expect(await attach()).toBe(`pi-cloud at ${url} runs 0.1.0, this CLI is 0.1.0+abc1234: run \`pi-cloud deploy cloudflare\` (or \`pi-cloud update\`)\n`)
      version = "0.1.0+abc1234"
      expect(await attach()).toBe(`Cannot connect to ${url.replace("http", "ws")}/v1/pi\n`)
    } finally {
      server.close()
      rmSync(join(home, "config", "pi-cloud", "config.json"))
    }
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
