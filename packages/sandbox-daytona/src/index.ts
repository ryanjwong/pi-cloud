import { Daytona, type Sandbox } from "@daytonaio/sdk"
import { type RemoteShell, SandboxError, type SandboxProvider, shellEnv } from "@pi-cloud/sandbox"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { posix } from "node:path"

export interface DaytonaSandboxOptions {
  readonly name?: string
  readonly apiKey?: string
  readonly apiUrl?: string
  readonly target?: string
  readonly snapshot?: string
  readonly autoStopInterval?: number
  readonly client?: Daytona
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const sandboxName = (key: string) => {
  const readable = key.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  return `pi-cloud-${readable}-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`
}

const WAITING = new Set(["creating", "starting", "restoring", "resuming", "pulling_snapshot", "pending_build", "building_snapshot"])

const started = async (sandbox: Sandbox) => {
  if (sandbox.state === "started") return
  if (sandbox.state !== undefined && WAITING.has(sandbox.state)) await sandbox.waitUntilStarted()
  else await sandbox.start()
}

const daytonaShell = (sandbox: Sandbox): RemoteShell => {
  const once = async (script: string, run: Parameters<RemoteShell["run"]>[1]) => {
    const session = `pi-cloud-${crypto.randomUUID()}`
    await sandbox.process.createSession(session)
    const abort = () => void sandbox.process.deleteSession(session).catch(() => {})
    run.signal?.addEventListener("abort", abort, { once: true })
    try {
      const exports = Object.entries(run.env ?? {}).map(([key, value]) => `export ${key}=${quote(value)}\n`).join("")
      const { cmdId } = await sandbox.process.executeSessionCommand(session, {
        command: `sh -c ${quote(exports + script)}`,
        runAsync: true
      })
      if (cmdId === undefined) throw new Error("Daytona did not return a command id")
      await sandbox.process.getSessionCommandLogs(
        session,
        cmdId,
        (chunk) => run.onStdout?.(chunk),
        (chunk) => run.onStderr?.(chunk)
      )
      for (let attempt = 0; attempt < 50; attempt++) {
        const command = await sandbox.process.getSessionCommand(session, cmdId)
        if (typeof command.exitCode === "number") return command.exitCode
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error("Daytona did not report the command's exit code")
    } catch (error) {
      if (run.signal?.aborted) return 137
      throw error
    } finally {
      run.signal?.removeEventListener("abort", abort)
      abort()
    }
  }
  return {
    id: `daytona:${sandbox.id}`,
    run: async (script, run) => {
      try {
        return await once(script, run)
      } catch (error) {
        await sandbox.refreshData()
        if (sandbox.state === "started" || run.signal?.aborted) throw error
        await started(sandbox)
        return once(script, run)
      }
    },
    writeFile: (path, content) => sandbox.fs.uploadFile(Buffer.from(content), path)
  }
}

export const daytonaSandboxes = (options: DaytonaSandboxOptions = {}): SandboxProvider => {
  const name = options.name ?? "daytona"
  let client = options.client
  const daytona = () =>
    (client ??= new Daytona({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.target === undefined ? {} : { target: options.target })
    }))
  const failure = (cause: unknown) => new SandboxError({ message: cause instanceof Error ? cause.message : String(cause) })
  const find = (id: string) => daytona().get(id).catch(() => undefined)

  return {
    name,
    create: ({ key, template }) =>
      Effect.tryPromise({
        try: async () => {
          const sandboxId = sandboxName(key)
          let sandbox = await find(sandboxId)
          if (sandbox === undefined) {
            const base = {
              name: sandboxId,
              labels: { "pi-cloud.sandbox": key },
              ...(options.autoStopInterval === undefined ? {} : { autoStopInterval: options.autoStopInterval })
            }
            const number = (value: unknown) => (typeof value === "number" ? value : undefined)
            const resources = {
              cpu: number(template.options?.["cpu"]),
              memory: number(template.options?.["memory"]),
              disk: number(template.options?.["disk"])
            }
            try {
              sandbox = template.image === undefined
                ? await daytona().create({ ...base, ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }) })
                : await daytona().create({ ...base, image: template.image, resources })
            } catch (error) {
              sandbox = await find(sandboxId)
              if (sandbox === undefined) throw error
            }
          }
          await started(sandbox)
          const workdir = (await sandbox.getWorkDir()) ?? (await sandbox.getUserHomeDir()) ?? "/home/daytona"
          const cwd = template.cwd === undefined ? workdir : posix.resolve(workdir, template.cwd)
          const made = await sandbox.process.executeCommand(`mkdir -p ${quote(cwd)}`)
          if (made.exitCode !== 0) throw new Error(`Could not create ${cwd}: ${made.result}`)
          return { provider: name, id: sandbox.id, cwd, data: { name: sandboxId } }
        },
        catch: failure
      }),
    connect: (handle, env) =>
      Effect.tryPromise({
        try: async () => {
          const sandbox = await daytona().get(handle.id)
          await started(sandbox)
          return shellEnv(daytonaShell(sandbox), { cwd: handle.cwd, env })
        },
        catch: failure
      }),
    destroy: (handle) =>
      Effect.tryPromise({
        try: async () => {
          const sandbox = await find(handle.id)
          await sandbox?.delete()
        },
        catch: failure
      })
  }
}
