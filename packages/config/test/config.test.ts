import { NodeServices } from "@effect/platform-node"
import { type Config, ConfigProvider, Effect, Exit, Option, Redacted } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, onTestFinished } from "vitest"
import { ControlPlaneEnv, modelCredentialLookup, RunnerEnv, sandboxSecretLookup, SETTINGS } from "../src/index.ts"

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

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
    expect(await secrets("ANTHROPIC_API_KEY")).toBeUndefined()
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

const value = <A>(exit: Exit.Exit<A, unknown>) => (exit as Exit.Success<A, unknown>).value

describe("server config", () => {
  it("defaults to isolated docker sandboxes and no local provider", async () => {
    const control = value(await load(ControlPlaneEnv, { GITHUB_WEBHOOK_SECRET: "gh" }))
    expect(control.settings.templates).toEqual({
      scratch: { provider: "docker", user: "1000:1000" },
      github: { provider: "docker", user: "1000:1000", credential: "GITHUB_TOKEN" }
    })
    expect(Option.getOrThrow(control.github).allowedAssociations).toEqual(["OWNER", "MEMBER", "COLLABORATOR"])
    const runner = value(await load(RunnerEnv, {}))
    expect(runner.unsafeLocalSandbox).toBe(false)
  })

  it("reads a typed config file that environment variables override", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-cloud-server-config-"))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const file = join(root, "pi-cloud.config.json")
    await writeFile(file, JSON.stringify({
      models: { default: "openai/gpt-6" },
      sandbox: { default: "api", templates: { api: { provider: "docker", repositories: ["acme/api"] } } },
      triggers: { github: { mention: "@bot" }, slack: { allowedUsers: ["U1"] } },
      unsafeLocalSandbox: true
    }))
    const env = { PI_CLOUD_CONFIG: file, GITHUB_WEBHOOK_SECRET: "gh", SLACK_SIGNING_SECRET: "s", SLACK_BOT_TOKEN: "t" }
    const control = value(await load(ControlPlaneEnv, { ...env, GITHUB_MENTION: "@pi" }))
    expect(control.model).toBe("openai/gpt-6")
    expect(control.settings.defaultSandbox).toBe("api")
    expect(control.settings.templates.api).toEqual({ provider: "docker", repositories: ["acme/api"] })
    expect(Option.getOrThrow(control.github).mention).toBe("@pi")
    expect(Option.getOrThrow(control.slack).allowedUsers).toEqual(["U1"])
    expect(value(await load(RunnerEnv, env)).unsafeLocalSandbox).toBe(true)
  })

  it("refuses a bad config, naming the schema path", async () => {
    const bad = (config: unknown, env: Record<string, string> = {}) => load(ControlPlaneEnv, { PI_CLOUD_CONFIG: JSON.stringify(config), ...env })
    const exit = await bad({ sandbox: { templates: { api: { provider: "docker", setup: "pnpm i" } } } })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain(`["sandbox"]["templates"]["api"]["setup"]`)
    expect(String(await bad({ sandboxes: {} }))).toContain(`["sandboxes"]`)
    expect(String(await bad({ sandbox: { default: "scrach" } }))).toContain("sandbox.default")
    expect(String(await bad({ triggers: { github: { template: "constructor" } } }, { GITHUB_WEBHOOK_SECRET: "gh" }))).toContain("triggers.github.template")
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
