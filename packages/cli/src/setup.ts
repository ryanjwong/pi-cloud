import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { githubAppCommand } from "./github-app.ts"
import { paths, readSecrets, readSettings, rejected, resolveConnection, saveTarget, unreachable, writePrivate } from "./settings.ts"
import { writeSopsSecrets } from "./sops.ts"

const INSTALL = "nix profile install github:ryanjwong/pi-cloud/stable#pi-cloud"

const root = resolve(import.meta.dirname, "../../..")
const app = join(root, "apps/cloudflare")
const wranglerBin = join(app, "node_modules/wrangler/bin/wrangler.js")
const wranglerEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" }
const checkout = !root.startsWith("/nix/store/") && existsSync(join(root, ".git"))

const REQUIRED = ["PI_CLOUD_API_KEYS", "PI_CLOUD_RUNNER_SECRET", "PI_CLOUD_CREDENTIAL_KEY"] as const
const ASKED = [
  { name: "ANTHROPIC_API_KEY", why: "Anthropic models (or skip, and sign in with Claude Pro/Max later: pi-cloud login anthropic)" },
  { name: "OPENAI_API_KEY", why: "OpenAI models (or skip, and sign in with ChatGPT later: pi-cloud login openai-codex)" },
  { name: "DAYTONA_API_KEY", why: "sandboxes for the coding tools, from app.daytona.io (without it the agent can only chat)" }
] as const
const PROMPTED = [...REQUIRED, ...ASKED.map((entry) => entry.name)]
const FORWARDED = [...PROMPTED, "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"]

const write = (text: string) => void process.stdout.write(text)
const step = (text: string) => write(`\n▸ ${text}\n`)
const has = (command: string) => spawnSync(command, ["--version"], { stdio: "ignore" }).error === undefined
const need = (command: string, args: ReadonlyArray<string>, options: SpawnSyncOptions = {}) => {
  if (spawnSync(command, args, { stdio: "inherit", ...options }).status !== 0) throw new Error(`${[command, ...args].join(" ")} failed`)
}
const signedIn = (whoami: { ok: boolean; output: string }) => whoami.ok && !/not authenticated|You are not/i.test(whoami.output)

const wrangler = (cwd: string, args: ReadonlyArray<string>, input?: string) =>
  new Promise<{ ok: boolean; output: string }>((done) => {
    const child = spawn(process.execPath, [wranglerBin, ...args], {
      cwd,
      env: wranglerEnv,
      stdio: [input === undefined ? "inherit" : "pipe", "pipe", "inherit"]
    })
    let output = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk
      process.stdout.write(chunk)
    })
    if (input !== undefined) child.stdin?.end(input)
    child.on("close", (code) => done({ ok: code === 0, output }))
  })

const privately = async <A>(run: (dir: string) => A | Promise<A>) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cloud-wrangler-"))
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const clean = (value: string) => [...value].filter((char) => char >= " " && char !== "\u007f").join("").replace(/\[20[01]~/g, "").trim()

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

const ask = async (question: string) => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return clean(await prompt.question(question))
  } finally {
    prompt.close()
  }
}

export interface GithubAppIo {
  readonly tty: boolean
  readonly ask: (question: string) => Promise<string>
  readonly create: (url: string) => Promise<Record<string, string>>
  readonly write: (text: string) => void
}

export const offerGithubApp = async (
  url: string,
  name: string,
  secrets: Readonly<Record<string, string>>,
  io: GithubAppIo = { tty: process.stdin.isTTY === true, ask, create: (url) => githubAppCommand({ url }, write), write }
): Promise<Record<string, string>> => {
  if (secrets.GITHUB_APP_ID) return {}
  const created = io.tty && /^(y|yes)?$/i.test(await io.ask("  Create the GitHub App now? (Y/n) "))
    ? await io.create(url).catch((error: unknown) => void io.write(`  GitHub App not created: ${error instanceof Error ? error.message : String(error)}\n`))
    : undefined
  if (created !== undefined) return created
  io.write(`  For GitHub access later: pi-cloud github-app --url ${url} && pi-cloud deploy cloudflare${name === "pi-cloud" ? "" : ` --name ${name}`}\n`)
  return {}
}

export const init = async (): Promise<Record<string, string>> => {
  for (const tool of ["sops", "age-keygen"]) {
    if (!has(tool)) throw new Error(`${tool} is missing: install sops and age (brew install sops age), or install pi-cloud with Nix`)
  }
  const { dir, ageKey, sopsConfig, secrets: file } = paths()
  step(`Secrets (encrypted in ${file})`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!existsSync(ageKey)) {
    if (spawnSync("age-keygen", ["-o", ageKey], { stdio: "ignore" }).status !== 0) throw new Error(`Could not create an age key at ${ageKey}`)
    write(`  created an age key: ${ageKey}  (back it up: without it secrets.yaml cannot be decrypted)\n`)
  }
  if (!existsSync(sopsConfig)) {
    const publicKey = spawnSync("age-keygen", ["-y", ageKey], { encoding: "utf8" }).stdout?.split("\n")[0] ?? ""
    if (!publicKey.startsWith("age1")) throw new Error(`${ageKey} is not an age key`)
    writePrivate(sopsConfig, `creation_rules:\n  - path_regex: secrets\\.yaml$\n    age: ${publicKey}\n`)
  }
  const current = readSecrets()
  const added: Record<string, string> = {}
  for (const name of PROMPTED) {
    if (typeof current[name] === "string" && clean(current[name]) !== current[name]) added[name] = clean(current[name])
  }
  for (const name of REQUIRED) {
    if (!current[name]) added[name] = randomBytes(32).toString("base64url")
  }
  if (process.stdin.isTTY) {
    for (const { name, why } of ASKED) {
      if (current[name]) continue
      const value = await askSecret(`  ${name}: ${why}\n    paste it, or press Enter to skip: `)
      if (value !== "") added[name] = value
    }
  }
  if (Object.keys(added).length > 0) {
    writeSopsSecrets(file, added)
    write(`  saved ${Object.keys(added).join(", ")}\n`)
  }
  return { ...current, ...added }
}

const readIfExists = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : undefined)

export const staleDependencies = (dir: string) => {
  const wanted = readIfExists(join(dir, "pnpm-lock.yaml"))
  return wanted !== undefined && wanted !== readIfExists(join(dir, "node_modules/.pnpm/lock.yaml"))
}

const STALE = `dependencies are out of date: run pnpm install in ${root}`

export const workerConfig = (name: string) => {
  const base = JSON.parse(readFileSync(join(app, "wrangler.json"), "utf8"))
  const build = process.env.PI_CLOUD_BUILD
  return { ...base, name, main: join(app, base.main), ...(build === undefined ? {} : { define: { PI_CLOUD_BUILD: JSON.stringify(build) } }) }
}

export const deploy = async (kind: string | undefined, name = "pi-cloud") => {
  if (kind !== "cloudflare") throw new Error("Usage: pi-cloud deploy cloudflare [--name <worker>]")
  if (checkout && staleDependencies(root)) throw new Error(STALE)
  const secrets = await init()
  await privately(async (project) => {
    const config = join(project, "wrangler.json")
    writeFileSync(config, JSON.stringify(workerConfig(name)))
    step("Signing in to Cloudflare")
    if (!signedIn(await wrangler(project, ["whoami"])) && !(await wrangler(project, ["login"])).ok) throw new Error("Cloudflare sign-in failed")
    step("Deploying the Worker")
    const deployed = await wrangler(project, ["deploy", "-c", config])
    if (!deployed.ok) throw new Error("wrangler deploy failed (see above)")
    const url = deployed.output.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0] ?? readSettings().targets?.[name]?.url
    if (url === undefined) throw new Error("Deployed, but wrangler printed no workers.dev URL: set PI_CLOUD_URL to the Worker's address")
    const send = async (values: Readonly<Record<string, string>>) => {
      const forwarded = Object.fromEntries(FORWARDED.flatMap((key) => (values[key] ? [[key, values[key]]] : [])))
      if (!(await wrangler(project, ["secret", "bulk", "-c", config], JSON.stringify(forwarded))).ok) {
        throw new Error("wrangler secret bulk failed (see above)")
      }
      return forwarded
    }
    step("Handing the secrets to the Worker")
    const forwarded = await send(secrets)
    const created = await offerGithubApp(url, name, secrets)
    if (Object.keys(created).length > 0) await send(created)
    step(`Waiting for ${url}`)
    let ready = false
    for (let attempt = 0; attempt < 30 && !ready; attempt++) {
      ready = await fetch(`${url}/health`).then((response) => response.ok, () => false)
      if (!ready) await new Promise((wait) => setTimeout(wait, 2_000))
    }
    write(ready ? "  up\n" : "  not answering yet; give it a minute\n")
    const saved = saveTarget(name, { kind: "cloudflare", url })
    write(`\n✓ pi-cloud is deployed, saved as the target ${name} in ${saved}.\n`)
    if (forwarded.DAYTONA_API_KEY === undefined) {
      const { ageKey, secrets: file } = paths()
      write(`  Without DAYTONA_API_KEY the agent can only chat: add one with \`SOPS_AGE_KEY_FILE=${ageKey} sops ${file}\`, then deploy again.\n`)
    }
  })
}

export const doctor = async (flagUrl?: string, flagKey?: string) => {
  const { dir, settings, ageKey, secrets } = paths()
  const check = (ok: boolean, text: string) => {
    if (!ok) process.exitCode = 1
    write(`${ok ? "✓" : "✗"} ${text}\n`)
  }
  const attempt = <A>(run: () => A) => {
    try {
      return run()
    } catch (error) {
      check(false, error instanceof Error ? error.message : String(error))
      return undefined
    }
  }
  if (checkout) {
    const stale = staleDependencies(root)
    check(!stale, stale ? STALE : "dependencies are up to date")
  }
  const tools = has("sops") && has("age-keygen")
  if (tools || existsSync(secrets) || Object.keys(readSettings().targets ?? {}).length > 0) check(tools, "sops and age are installed")
  else write("· sops and age are needed for init and deploy: brew install sops age\n")
  const loose = [settings, ageKey, secrets].filter((file) => existsSync(file) && (statSync(file).mode & 0o077) !== 0)
  check(loose.length === 0, loose.length === 0 ? `${dir} is private` : `others can read ${loose.join(", ")}: chmod 600 them`)
  const decrypted = existsSync(secrets) ? attempt(readSecrets) : {}
  if (decrypted === undefined) return
  if (existsSync(secrets)) check(true, `${secrets} decrypts`)
  const connection = attempt(() => resolveConnection(flagUrl, flagKey, () => decrypted))
  if (connection === undefined) return
  const { url, apiKey } = connection
  const up = await fetch(new URL("/health", url)).then((response) => response.ok, () => false)
  check(up, up ? `${url} is up` : unreachable(url))
  if (!up) return
  const status = await fetch(new URL("/v1/credentials", url), {
    headers: apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }
  }).then((response) => response.status, () => 0)
  check(status === 200, status === 200 ? "the API key is accepted" : status === 401 ? rejected(url) : `GET /v1/credentials: ${status}`)
  if (Object.values(readSettings().targets ?? {}).some((target) => target.kind === "cloudflare")) {
    const whoami = await privately((cwd) => spawnSync(process.execPath, [wranglerBin, "whoami"], { cwd, env: wranglerEnv, encoding: "utf8" }))
    check(signedIn({ ok: whoami.status === 0, output: whoami.stdout }), "signed in to Cloudflare")
  }
}

export const update = async () => {
  const method = checkout ? "git" : root.startsWith("/nix/store/") ? "nix" : undefined
  if (method === undefined) throw new Error(`pi-cloud was not installed with Nix or from a git checkout; reinstall it: ${INSTALL}`)
  step("Updating pi-cloud")
  if (method === "nix") need("nix", ["profile", "upgrade", "--refresh", "pi-cloud"])
  else {
    need("git", ["-C", root, "pull", "--ff-only"])
    need("pnpm", ["install", "--frozen-lockfile"], { cwd: root })
  }
  const [cli = "pi-cloud", ...prefix] = method === "nix" ? [] : [process.execPath, process.argv[1]!]
  const env = { ...process.env, PI_CLOUD_BUILD: undefined }
  const targets = Object.entries(readSettings().targets ?? {})
  for (const [name, target] of targets) need(cli, [...prefix, "deploy", target.kind, "--name", name], { stdio: ["ignore", "inherit", "inherit"], env })
  if (targets.length > 0) process.exitCode = spawnSync(cli, [...prefix, "doctor"], { stdio: "inherit", env }).status ?? 1
}
