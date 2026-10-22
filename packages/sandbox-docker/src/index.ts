import { type RemoteShell, SandboxError, type SandboxProvider, shellEnv } from "@pi-cloud/sandbox"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"

export interface DockerSandboxOptions {
  readonly name?: string
  readonly image?: string
  readonly docker?: string
  readonly prefix?: string
  readonly networks?: ReadonlyArray<string>
  readonly memory?: string
  readonly cpus?: string
}

export const DEFAULT_IMAGE = "buildpack-deps:bookworm-scm@sha256:1314fd2a9c83b257b37132883b3c8e326d3909211bdcb419c9757399ebc34bf3"
const WORKSPACE = "/workspace"
const OPTIONS = ["memory", "cpus", "network"]
const CLI_VARIABLES = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]

const cliEnv = () => Object.fromEntries(CLI_VARIABLES.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]))

const withEnvFile = async <A>(env: Readonly<Record<string, string>>, run: (args: ReadonlyArray<string>) => Promise<A>) => {
  const entries = Object.entries(env)
  if (entries.length === 0) return run([])
  const bad = entries.find(([, value]) => /[\r\n]/.test(value))
  if (bad !== undefined) throw new Error(`Sandbox variable ${bad[0]} contains a line break, which docker cannot pass`)
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-env-"))
  try {
    await writeFile(join(dir, "env"), entries.map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 })
    return await run(["--env-file", join(dir, "env")])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const safe = (key: string) => key.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")

type Run = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export const dockerSandboxes = (options: DockerSandboxOptions = {}): SandboxProvider => {
  const name = options.name ?? "docker"
  const docker = options.docker ?? "docker"
  const prefix = options.prefix ?? "pi-cloud-"
  const networks = (options.networks ?? ["bridge", "none"]).filter((network) => network !== "host" && !network.startsWith("container:"))
  const failure = (cause: unknown) =>
    new SandboxError({
      message: (cause as { code?: string }).code === "ENOENT"
        ? `Docker is not available (${docker} not found); install and start Docker, or set PI_CLOUD_UNSAFE_LOCAL_SANDBOX=1`
        : cause instanceof Error ? cause.message : String(cause)
    })

  const cli = (args: ReadonlyArray<string>) =>
    new Promise<Run>((resolve, reject) => {
      const child = spawn(docker, args, { env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.stderr.on("data", (chunk) => (stderr += chunk))
      child.on("error", reject)
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    })

  const checked = async (args: ReadonlyArray<string>) => {
    const result = await cli(args)
    if (result.code !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim() || result.code}`)
    return result.stdout.trim()
  }

  const state = async (container: string) => {
    const result = await cli(["inspect", "--format", "{{.State.Running}}", container])
    if (result.code !== 0) return "missing" as const
    return result.stdout.trim() === "true" ? "running" as const : "stopped" as const
  }

  const ensureRunning = async (container: string) => {
    const current = await state(container)
    if (current === "missing") throw new Error(`Sandbox container ${container} no longer exists`)
    if (current === "stopped") await checked(["start", container])
  }

  const shell = (container: string): RemoteShell => ({
    id: `docker:${container}`,
    stdin: true,
    run: (script, run) =>
      withEnvFile(run.env ?? {}, (envFile) => new Promise((resolve, reject) => {
        const args = ["exec", ...(run.stdin === undefined ? [] : ["-i"]), ...envFile]
        const child = spawn(docker, [...args, container, "sh", "-c", script], {
          env: cliEnv(),
          stdio: [run.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
        })
        child.stdout?.on("data", (chunk: Buffer) => run.onStdout?.(new Uint8Array(chunk)))
        child.stderr?.on("data", (chunk: Buffer) => run.onStderr?.(new Uint8Array(chunk)))
        const abort = () => child.kill("SIGKILL")
        run.signal?.addEventListener("abort", abort, { once: true })
        child.on("error", reject)
        child.on("close", (code) => {
          run.signal?.removeEventListener("abort", abort)
          resolve(code ?? 137)
        })
        if (run.stdin !== undefined) {
          child.stdin?.on("error", () => {})
          child.stdin?.end(run.stdin)
        }
      }))
  })

  return {
    name,
    create: ({ key, template }) =>
      Effect.tryPromise({
        try: async () => {
          const container = `${prefix}${safe(key)}`
          const refused = Object.keys(template.options ?? {}).find((key) => !OPTIONS.includes(key))
          if (refused !== undefined) throw new Error(`Docker sandbox option "${refused}" is not allowed`)
          const settings = { network: networks[0], memory: options.memory ?? "4g", cpus: options.cpus, ...template.options }
          if (settings.network !== undefined && !networks.includes(String(settings.network))) {
            throw new Error(`Docker network "${String(settings.network)}" is not allowed`)
          }
          const option = (flag: string, value: unknown) => (typeof value === "string" ? [flag, value] : [])
          if ((await state(container)) === "missing") {
            const created = await cli([
              "run",
              "--detach",
              "--name",
              container,
              "--label",
              `pi-cloud.sandbox=${key}`,
              "--init",
              "--security-opt",
              "no-new-privileges",
              "--cap-drop",
              "ALL",
              "--pids-limit",
              "512",
              "--workdir",
              WORKSPACE,
              ...option("--user", template.user),
              ...(template.user === undefined ? [] : ["--env", "HOME=/tmp"]),
              ...option("--network", settings.network),
              ...option("--memory", settings.memory),
              ...option("--cpus", settings.cpus),
              template.image ?? options.image ?? DEFAULT_IMAGE,
              "sleep",
              "infinity"
            ])
            if (created.code !== 0 && !created.stderr.includes("is already in use")) {
              throw new Error(`docker run failed: ${created.stderr.trim()}`)
            }
          }
          await ensureRunning(container)
          const cwd = template.cwd === undefined ? WORKSPACE : posix.resolve(WORKSPACE, template.cwd)
          await checked(["exec", "--user", "0", container, "sh", "-c", 'mkdir -p "$1" && { chmod 1777 "$1" 2>/dev/null || true; }', "sh", cwd])
          return { provider: name, id: container, cwd, data: { container } }
        },
        catch: failure
      }),
    connect: (handle, env) =>
      Effect.tryPromise({
        try: async () => {
          await ensureRunning(handle.id)
          return shellEnv(shell(handle.id), { cwd: handle.cwd, env })
        },
        catch: failure
      }),
    destroy: (handle) =>
      Effect.tryPromise({
        try: async () => void (await cli(["rm", "--force", "--volumes", handle.id])),
        catch: failure
      })
  }
}
