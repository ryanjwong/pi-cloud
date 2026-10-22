import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
    secrets: join(dir, "secrets.yaml")
  }
}

export const writePrivate = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, text, { mode: 0o600 })
  chmodSync(file, 0o600)
}

export const readSettings = (): CliSettings => {
  const file = paths().settings
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CliSettings
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
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
  const saved: CliSettings & { readonly url?: string } = readSettings()
  if (saved.url !== undefined && saved.targets === undefined) {
    const { dir, settings } = paths()
    throw new Error(`${settings} is from an older pi-cloud: move your age key (as age.key), secrets.yaml and .sops.yaml into ${dir}, then run pi-cloud deploy cloudflare`)
  }
  const target = saved.default === undefined ? undefined : saved.targets?.[saved.default]
  const explicit = flagUrl ?? process.env.PI_CLOUD_URL
  const savedKey = () => secrets().PI_CLOUD_API_KEYS?.split(",")[0]?.trim()
  return {
    url: explicit ?? target?.url ?? LOCAL_URL,
    apiKey: flagKey ?? process.env.PI_CLOUD_API_KEY ?? (explicit === undefined && target !== undefined ? savedKey() : undefined)
  }
}

export const unreachable = (url: string) =>
  url === LOCAL_URL
    ? "No pi-cloud server is set up. Run `pi-cloud deploy cloudflare`, or start a local one with `pi-cloud-server` (`pnpm start` in a checkout)."
    : `Can't reach pi-cloud at ${url}.`

export const rejected = (url: string) => `pi-cloud at ${url} rejected the API key.`
