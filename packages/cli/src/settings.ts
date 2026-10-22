import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface CliSettings {
  readonly url?: string
  readonly sandboxProvider?: string
  readonly secretsFile?: string
}

export const settingsFile = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-cloud", "config.json")

export const readSettings = (): CliSettings => {
  const file = settingsFile()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CliSettings
  } catch {
    throw new Error(`${file} is not valid JSON`)
  }
}

export const writeSettings = (settings: CliSettings) => {
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
  chmodSync(file, 0o600)
  return file
}

export const apiKeyFrom = (secretsFile: string): string => {
  try {
    const keys = execFileSync("sops", ["decrypt", "--extract", '["PI_CLOUD_API_KEYS"]', secretsFile], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    })
    return keys.split(",")[0]!.trim()
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message
    throw new Error(`Could not read the API key from ${secretsFile} with sops: ${detail}`)
  }
}

export interface Connection {
  readonly url: string
  readonly apiKey: string | undefined
  readonly sandboxProvider: string
}

export const resolveConnection = (flagUrl: string | undefined): Connection => {
  const saved = readSettings()
  const url = flagUrl ?? process.env.PI_CLOUD_URL ?? saved.url ?? "http://127.0.0.1:8787"
  const fromSettings = flagUrl === undefined && process.env.PI_CLOUD_URL === undefined && saved.url !== undefined
  const apiKey = process.env.PI_CLOUD_API_KEY ?? (fromSettings && saved.secretsFile !== undefined ? apiKeyFrom(saved.secretsFile) : undefined)
  return { url, apiKey, sandboxProvider: process.env.PI_CLOUD_SANDBOX_PROVIDER ?? saved.sandboxProvider ?? "local" }
}

export const unreachable = (url: string) =>
  url === "http://127.0.0.1:8787"
    ? "No pi-cloud server is set up. Run `nix run .#deploy-cloudflare` (or `pnpm start` for a local one)."
    : `Can't reach pi-cloud at ${url}.`

export const rejected = (url: string) => `pi-cloud at ${url} rejected the API key.`
