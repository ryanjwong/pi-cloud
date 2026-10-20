import { type RemoteShell, SandboxError, type SandboxProvider, shellEnv } from "@pi-cloud/sandbox"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { posix } from "node:path"

export interface DockerSandboxOptions {
  /** Provider name templates refer to. Default `docker`. */
  readonly name?: string
  /** Image for templates that name none. It needs a POSIX shell and coreutils; git for repositories. */
  readonly image?: string
  /** The Docker CLI. Default `docker`; it talks to whatever daemon its environment points at (`DOCKER_HOST`). */
  readonly docker?: string
  /** Container name prefix. */
  readonly prefix?: string
  /** Defaults for every container; a template's `options` override them. */
  readonly network?: string
  readonly memory?: string
  readonly cpus?: string
}

const DEFAULT_IMAGE = "buildpack-deps:bookworm-scm"
const WORKSPACE = "/workspace"

const safe = (key: string) => key.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")

type Run = {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Sandboxes as Docker containers, one per sandbox, kept running between commands and across runner restarts.
 * Commands see only the container's own environment plus the template's variables and secrets, which are passed
 * per command (never baked into the container, so `docker inspect` does not show them). Containers run without
 * new privileges and with `--init`; `network`, `memory` and `cpus` limit them further.
 */
export const dockerSandboxes = (options: DockerSandboxOptions = {}): SandboxProvider => {
  const name = options.name ?? "docker"
  const docker = options.docker ?? "docker"
  const prefix = options.prefix ?? "pi-cloud-"
  const failure = (cause: unknown) => new SandboxError({ message: cause instanceof Error ? cause.message : String(cause) })

  const cli = (args: ReadonlyArray<string>, env?: Readonly<Record<string, string>>) =>
    new Promise<Run>((resolve, reject) => {
      const child = spawn(docker, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
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

  /** `running`, `stopped`, or `missing`. */
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
      new Promise((resolve, reject) => {
        // Values travel in the CLI's environment and only their names on its command line, so secrets do not show
        // up in the runner's process list.
        const env = run.env ?? {}
        const args = ["exec", ...(run.stdin === undefined ? [] : ["-i"]), ...Object.keys(env).flatMap((key) => ["-e", key])]
        const child = spawn(docker, [...args, container, "sh", "-c", script], {
          env: { ...process.env, ...env },
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
      })
  })

  return {
    name,
    create: ({ key, template }) =>
      Effect.tryPromise({
        try: async () => {
          const container = `${prefix}${safe(key)}`
          const settings = { network: options.network, memory: options.memory, cpus: options.cpus, ...template.options }
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
              "NET_RAW",
              "--workdir",
              WORKSPACE,
              ...option("--network", settings.network),
              ...option("--memory", settings.memory),
              ...option("--cpus", settings.cpus),
              template.image ?? options.image ?? DEFAULT_IMAGE,
              "sleep",
              "infinity"
            ])
            // Creation is keyed by name, so a concurrent create of the same sandbox is the same container.
            if (created.code !== 0 && !created.stderr.includes("is already in use")) {
              throw new Error(`docker run failed: ${created.stderr.trim()}`)
            }
          }
          await ensureRunning(container)
          const cwd = template.cwd === undefined ? WORKSPACE : posix.resolve(WORKSPACE, template.cwd)
          await checked(["exec", container, "mkdir", "-p", cwd])
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
