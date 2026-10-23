import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface Target {
  readonly kind: "cloudflare"
  readonly url: string
}

export interface CliSettings {
  readonly default?: string
  readonly targets?: Readonly<Record<string, Target>>
}

export const LOCAL_URL = "http://127.0.0.1:8787"

export const paths = () => {
  const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-cloud")
  return {
    dir,
    settings: join(dir, "config.json"),
    ageKey: process.env.SOPS_AGE_KEY_FILE ?? join(dir, "age.key"),
    sopsConfig: join(dir, ".sops.yaml"),
    secrets: join(dir, "secrets.yaml"),
    adminToken: join(dir, "admin-token")
  }
}

export const writePrivate = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 })
  chmodSync(`${file}.tmp`, 0o600)
  renameSync(`${file}.tmp`, file)
}

const parseSettings = (file: string): CliSettings & { readonly url?: string; readonly secretsFile?: string } => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
}

const sopsDefaultKeys = () =>
  [process.env.XDG_CONFIG_HOME, join(homedir(), "Library", "Application Support"), join(homedir(), ".config")].flatMap((dir) =>
    dir === undefined ? [] : [join(dir, "sops", "age", "keys.txt")]
  )

const migrate = (url: string, secretsFile: string | undefined): CliSettings => {
  const { dir, settings, secrets, sopsConfig, ageKey } = paths()
  chmodSync(dir, 0o700)
  const key = process.env.SOPS_AGE_KEY_FILE === undefined ? sopsDefaultKeys().find((file) => existsSync(file)) : undefined
  const copies = [[secretsFile, secrets], [secretsFile && join(dirname(secretsFile), ".sops.yaml"), sopsConfig], [key, ageKey]] as const
  const copied = copies.flatMap(([from, to]) => {
    if (from === undefined || !existsSync(from) || existsSync(to)) return []
    writePrivate(to, readFileSync(from, "utf8"))
    return [to]
  })
  if (!existsSync(secrets)) throw new Error(`${settings} is from an older pi-cloud and has no secrets file to migrate: remove it and run \`pi-cloud deploy cloudflare\``)
  const migrated = { default: "cloudflare", targets: { cloudflare: { kind: "cloudflare", url } } } as const
  writePrivate(settings, `${JSON.stringify(migrated, null, 2)}\n`)
  process.stderr.write(`Migrated your older pi-cloud config to ${[settings, ...copied].join(", ")} (originals untouched).\n`)
  return migrated
}

export const readSettings = (): CliSettings => {
  const file = paths().settings
  if (!existsSync(file)) return {}
  const saved = parseSettings(file)
  return saved.url !== undefined && saved.targets === undefined ? migrate(saved.url, saved.secretsFile) : saved
}

export const saveTarget = (name: string, target: Target) => {
  const file = paths().settings
  const saved = readSettings()
  const targets = { ...saved.targets, [name]: target }
  writePrivate(file, `${JSON.stringify({ default: saved.targets?.[name] === undefined ? name : saved.default ?? name, targets }, null, 2)}\n`)
  return file
}

export const sopsEnv = () => {
  const { ageKey } = paths()
  return existsSync(ageKey) ? { ...process.env, SOPS_AGE_KEY_FILE: ageKey } : process.env
}

export const readSecrets = (): Record<string, string> => {
  const file = paths().secrets
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(execFileSync("sops", ["decrypt", "--output-type", "json", file], {
      encoding: "utf8",
      env: sopsEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    }))
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message
    throw new Error(`Could not decrypt ${file} with sops: ${detail}`)
  }
}

export interface Connection {
  readonly url: string
  readonly apiKey: string | undefined
}

export const resolveConnection = (flagUrl?: string, flagKey?: string, secrets = readSecrets): Connection => {
  const saved = readSettings()
  const target = saved.default === undefined ? undefined : saved.targets?.[saved.default]
  const explicit = flagUrl ?? process.env.PI_CLOUD_URL
  const savedKey = () => secrets().PI_CLOUD_API_KEYS?.split(",")[0]?.trim()
  const url = explicit ?? target?.url ?? LOCAL_URL
  const localKey = () =>
    ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) && existsSync(paths().adminToken)
      ? readFileSync(paths().adminToken, "utf8").trim()
      : undefined
  return {
    url,
    apiKey: flagKey ?? process.env.PI_CLOUD_API_KEY ?? (explicit === undefined && target !== undefined ? savedKey() : localKey())
  }
}

export const unreachable = (url: string) =>
  url === LOCAL_URL
    ? "No pi-cloud server is set up. Run `pi-cloud deploy cloudflare`, or start a local one with `pi-cloud-server` (`pnpm start` in a checkout)."
    : `Can't reach pi-cloud at ${url}.`

export const rejected = (url: string) => `pi-cloud at ${url} rejected the API key.`

export const versionSkew = (url: string, server: string, cli: string) => {
  const [name, target] = Object.entries(readSettings().targets ?? {}).find(([, saved]) => saved.url === url) ?? []
  return target === undefined || server === cli
    ? undefined
    : `pi-cloud at ${url} runs ${server}, this CLI is ${cli}: run \`pi-cloud deploy ${target.kind}${name === "pi-cloud" ? "" : ` --name ${name}`}\` (or \`pi-cloud update\`)`
}
