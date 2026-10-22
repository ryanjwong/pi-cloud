import { MODEL_CREDENTIALS } from "@pi-cloud/config"
import { writeSettings } from "@pi-cloud/cli/settings"
import { writeSopsSecrets } from "@pi-cloud/cli/sops"
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../../..")
const app = resolve(import.meta.dirname, "..")
const secretsDir = process.env.PI_CLOUD_SECRETS_DIR ?? root
const secretsFile = join(secretsDir, "secrets.yaml")
const sopsConfig = join(secretsDir, ".sops.yaml")
const PLACEHOLDER = /age1replacewithyourpublickey\w*/

const REQUIRED = ["PI_CLOUD_API_KEYS", "PI_CLOUD_RUNNER_SECRET", "PI_CLOUD_CREDENTIAL_KEY"] as const
const ASKED = [
  { name: "ANTHROPIC_API_KEY", why: "Anthropic models (or skip, and sign in with Claude Pro/Max later: pi-cloud login anthropic)" },
  { name: "OPENAI_API_KEY", why: "OpenAI models (or skip, and sign in with ChatGPT later: pi-cloud login openai-codex)" },
  { name: "DAYTONA_API_KEY", why: "sandboxes for the coding tools, from app.daytona.io (without it the agent can only chat)" },
  { name: "GITHUB_TOKEN", why: "cloning private repositories and pushing branches (skip for public repositories)" }
] as const
const FORWARDED = [...REQUIRED, ...MODEL_CREDENTIALS, "DAYTONA_API_KEY", "GITHUB_TOKEN"]

const step = (text: string) => console.log(`\n▸ ${text}`)
const fail = (text: string): never => {
  console.error(`\n✗ ${text}`)
  process.exit(1)
}
const has = (command: string) => spawnSync(command, ["--version"], { stdio: "ignore" }).error === undefined
const run = (command: string, args: ReadonlyArray<string>, options: { input?: string; cwd?: string } = {}) => {
  const result = spawnSync(command, args, { cwd: options.cwd ?? secretsDir, input: options.input, encoding: "utf8", stdio: [options.input === undefined ? "inherit" : "pipe", "pipe", "pipe"] })
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}
const wrangler = (args: ReadonlyArray<string>, options: { input?: string; capture?: boolean } = {}) =>
  new Promise<{ ok: boolean; output: string }>((done) => {
    const child = spawn(process.env.PI_CLOUD_WRANGLER ?? "npx", [...(process.env.PI_CLOUD_WRANGLER === undefined ? ["wrangler"] : []), ...args], {
      cwd: app,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: [options.input === undefined ? "inherit" : "pipe", options.capture === true ? "pipe" : "inherit", "inherit"]
    })
    let output = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk
      process.stdout.write(chunk)
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
    child.on("close", (code) => done({ ok: code === 0, output }))
  })

const clean = (value: string) => [...value].filter((char) => char >= " " && char !== "\u007f").join("").replace(/\[20[01]~/g, "").trim()

const askSecret = (question: string) =>
  new Promise<string>((done) => {
    process.stdout.write(question)
    const stdin = process.stdin
    stdin.setRawMode?.(true)
    stdin.resume()
    let value = ""
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode?.(false)
          stdin.pause()
          stdin.off("data", onData)
          process.stdout.write("\n")
          return done(clean(value))
        }
        if (char === "\u0003") process.exit(130)
        if (char === "\u007f") value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.on("data", onData)
  })

step("Checking tools")
for (const tool of ["sops", "age-keygen"]) {
  if (!has(tool)) fail(`${tool} is missing. Install it: brew install sops age   (or run inside: nix develop)`)
}
console.log("  sops, age: ok")

step("Setting up SOPS")
const keyFile = process.env.SOPS_AGE_KEY_FILE ?? (process.platform === "darwin" && process.env.XDG_CONFIG_HOME === undefined
  ? join(homedir(), "Library/Application Support/sops/age/keys.txt")
  : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sops/age/keys.txt"))
if (!existsSync(keyFile)) {
  mkdirSync(dirname(keyFile), { recursive: true })
  if (!run("age-keygen", ["-o", keyFile]).ok) fail(`Could not create an age key at ${keyFile}`)
  console.log(`  created your age key: ${keyFile}  (back it up: without it secrets.yaml cannot be decrypted)`)
} else {
  console.log(`  using your age key: ${keyFile}`)
}
const publicKey = run("age-keygen", ["-y", keyFile]).stdout.trim()
if (!publicKey.startsWith("age1")) fail(`${keyFile} is not an age key`)
const config = readFileSync(sopsConfig, "utf8")
if (PLACEHOLDER.test(config)) {
  writeFileSync(sopsConfig, config.replace(PLACEHOLDER, publicKey))
  console.log(`  .sops.yaml now encrypts to your key (${publicKey.slice(0, 16)}…)`)
}

step("Secrets (encrypted in secrets.yaml)")
const current: Record<string, unknown> = existsSync(secretsFile)
  ? (() => {
    const decrypted = run("sops", ["decrypt", "--output-type", "json", secretsFile])
    if (!decrypted.ok) fail(`Cannot decrypt secrets.yaml with your key:\n${decrypted.stderr}`)
    return JSON.parse(decrypted.stdout)
  })()
  : {}
const present = (name: string) => typeof current[name] === "string" && current[name] !== ""
const added: Record<string, string> = {}
for (const [name, value] of Object.entries(current)) {
  if (typeof value === "string" && clean(value) !== value) added[name] = clean(value)
}
for (const name of REQUIRED) {
  if (!present(name)) {
    added[name] = randomBytes(32).toString("base64url")
    console.log(`  generated ${name}`)
  }
}
if (process.stdin.isTTY) {
  for (const { name, why } of ASKED) {
    if (present(name)) {
      console.log(`  ${name}: set`)
      continue
    }
    const value = await askSecret(`  ${name} — ${why}\n    paste it, or press Enter to skip: `)
    if (value !== "") added[name] = value
  }
}
if (Object.keys(added).length > 0) {
  process.chdir(secretsDir)
  writeSopsSecrets(secretsFile, added)
  console.log(`  saved ${Object.keys(added).join(", ")} to secrets.yaml`)
}
const secrets: Record<string, string> = { ...(current as Record<string, string>), ...added }

step("Signing in to Cloudflare")
const whoami = await wrangler(["whoami"], { capture: true })
if (!whoami.ok || /not authenticated|You are not/i.test(whoami.output)) {
  if (!(await wrangler(["login"])).ok) fail("Cloudflare sign-in failed")
}

step("Deploying the Worker")
const deployed = await wrangler(["deploy"], { capture: true })
if (!deployed.ok) fail("wrangler deploy failed (see above)")
const url = deployed.output.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0]

step("Handing the secrets to the Worker")
const forwarded = Object.fromEntries(FORWARDED.filter((name) => typeof secrets[name] === "string" && secrets[name] !== "").map((name) => [name, secrets[name]]))
if (!(await wrangler(["secret", "bulk"], { input: JSON.stringify(forwarded) })).ok) fail("wrangler secret bulk failed (see above)")

if (url !== undefined) {
  step(`Waiting for ${url}`)
  let ready = false
  for (let attempt = 0; attempt < 30 && !ready; attempt++) {
    ready = await fetch(`${url}/health`).then((response) => response.ok, () => false)
    if (!ready) await new Promise((wait) => setTimeout(wait, 2_000))
  }
  console.log(ready ? "  up" : "  not answering yet; give it a minute")
}
const saved = writeSettings({
  ...(url === undefined ? {} : { url }),
  ...(forwarded.DAYTONA_API_KEY === undefined ? {} : { sandboxProvider: "daytona" }),
  secretsFile
})
console.log(`\n✓ pi-cloud is deployed, and the pi-cloud command is set up to use it (${saved}).`)
if (forwarded.DAYTONA_API_KEY === undefined) {
  console.log("  Without DAYTONA_API_KEY the agent can only chat: add one with `sops secrets.yaml`, then deploy again.")
}
if (process.env.PI_CLOUD_VIA_NIX === undefined) {
  console.log(`\nTo get the command, add this to your shell profile:\n\n  alias pi-cloud="node ${join(root, "packages/cli/src/main.ts")}"`)
}
