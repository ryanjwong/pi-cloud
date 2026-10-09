import { NodeServices } from "@effect/platform-node"
import { type Config, ConfigProvider, Effect, Exit, Option, Redacted } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ControlPlaneEnv, modelCredentialLookup, RunnerEnv, sandboxSecretLookup, SETTINGS } from "../src/index.ts"

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

/** Environment variables first, then a secrets directory: the same order the servers use. */
const load = async <A>(config: Config.Config<A>, env: Record<string, string>, files: Record<string, string> = {}) => {
  dir = await mkdtemp(join(tmpdir(), "pi-cloud-config-"))
  for (const [name, value] of Object.entries(files)) await writeFile(join(dir, name), `${value}\n`)
  const directory = dir
  const provider = Effect.gen(function*() {
    return ConfigProvider.orElse(ConfigProvider.fromEnvRecord(env as never), yield* ConfigProvider.fromDir({ rootPath: directory }))
  })
  return Effect.runPromiseExit(
    Effect.gen(function*() {
      return yield* config
    }).pipe(Effect.provide(ConfigProvider.layer(provider)), Effect.provide(NodeServices.layer))
  )
}

describe("RunnerEnv", () => {
  it("reads model keys and listed sandbox secrets from the environment and the secrets directory", async () => {
    const exit = await load(RunnerEnv, { SANDBOX_SECRETS: "GITHUB_TOKEN, NPM_TOKEN", NPM_TOKEN: "npm-123" }, {
      ANTHROPIC_API_KEY: "sk-ant-file",
      GITHUB_TOKEN: "ghp-file"
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    const env = (exit as Exit.Success<any, unknown>).value
    expect(modelCredentialLookup(env)("ANTHROPIC_API_KEY")).toBe("sk-ant-file")
    expect(modelCredentialLookup(env)("OPENAI_API_KEY")).toBeUndefined()
    const secrets = sandboxSecretLookup(env)
    expect(await secrets("GITHUB_TOKEN")).toBe("ghp-file")
    expect(await secrets("NPM_TOKEN")).toBe("npm-123")
    // Not listed in SANDBOX_SECRETS, so never handed to a sandbox even though it is configured.
    expect(await secrets("ANTHROPIC_API_KEY")).toBeUndefined()
    // Secrets never print their value.
    expect(String(env.sandboxSecrets.GITHUB_TOKEN)).not.toContain("ghp-file")
  })

  it("refuses to start when a listed sandbox secret is missing", async () => {
    const exit = await load(RunnerEnv, { SANDBOX_SECRETS: "MISSING_TOKEN" })
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("ControlPlaneEnv", () => {
  it("enables connectors only when their secrets are set", async () => {
    const exit = await load(ControlPlaneEnv, { GITHUB_WEBHOOK_SECRET: "gh", PI_CLOUD_API_KEYS: "a, b", PORT: "9000" })
    const env = (exit as Exit.Success<any, unknown>).value
    expect(env.port).toBe(9000)
    expect(Option.isSome(env.github)).toBe(true)
    expect(Option.isNone(env.slack)).toBe(true)
    expect(env.apiKeys.map((key: Redacted.Redacted<string>) => Redacted.value(key))).toEqual(["a", "b"])
  })
})

describe("secrets.example.yaml", () => {
  it("lists every secret setting", async () => {
    const example = await readFile(join(import.meta.dirname, "../../../secrets.example.yaml"), "utf8")
    for (const setting of SETTINGS.filter((setting) => setting.secret)) {
      expect(example, setting.name).toMatch(new RegExp(`^${setting.name}:`, "m"))
    }
  })
})
