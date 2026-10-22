import type { Context } from "@earendil-works/chord"
import type { Daytona } from "@daytonaio/sdk"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { daytonaSandboxes } from "../src/index.ts"

const context = {} as Context

const fakeDaytona = (workdir: string) => {
  const sandboxes = new Map<string, any>()
  const calls: Array<string> = []
  const make = (name: string) => {
    const commands = new Map<string, { output: Promise<void>; exitCode?: number; out: Array<[string, string]> }>()
    const sandbox: any = {
      id: `id-${name}`,
      state: "stopped",
      start: async () => {
        calls.push("start")
        sandbox.state = "started"
      },
      waitUntilStarted: async () => {},
      refreshData: async () => {},
      delete: async () => void sandboxes.delete(name),
      getWorkDir: async () => workdir,
      getUserHomeDir: async () => workdir,
      process: {
        executeCommand: async (command: string) => {
          const child = spawn("sh", ["-c", command])
          return { exitCode: await new Promise((resolve) => child.on("close", resolve)), result: "" }
        },
        createSession: async (id: string) => void calls.push(`session ${id.length > 0}`),
        deleteSession: async () => {},
        executeSessionCommand: async (_session: string, request: { command: string; runAsync: boolean }) => {
          const id = `cmd-${commands.size}`
          const child = spawn("sh", ["-c", request.command], { env: { PATH: process.env["PATH"]!, HOME: workdir } })
          const record: any = { out: [] }
          child.stdout.on("data", (chunk) => record.out.push(["stdout", chunk.toString()]))
          child.stderr.on("data", (chunk) => record.out.push(["stderr", chunk.toString()]))
          record.output = new Promise<void>((resolve) => child.on("close", (code) => {
            record.exitCode = code ?? 137
            resolve()
          }))
          commands.set(id, record)
          return { cmdId: id }
        },
        getSessionCommandLogs: async (_session: string, id: string, onStdout: (chunk: string) => void, onStderr: (chunk: string) => void) => {
          const record = commands.get(id)!
          await record.output
          for (const [stream, chunk] of record.out) (stream === "stdout" ? onStdout : onStderr)(chunk)
        },
        getSessionCommand: async (_session: string, id: string) => ({ exitCode: commands.get(id)!.exitCode })
      },
      fs: {
        uploadFile: async (content: Buffer, path: string) => {
          calls.push(`upload ${path}`)
          await writeFile(path, content)
        }
      }
    }
    return sandbox
  }
  const client = {
    get: async (id: string) => {
      const found = sandboxes.get(id) ?? [...sandboxes.values()].find((sandbox) => sandbox.id === id)
      if (found === undefined) throw new Error("not found")
      return found
    },
    create: async (params: { name: string; labels: Record<string, string> }) => {
      calls.push(`create ${params.labels["pi-cloud.sandbox"]}`)
      const sandbox = make(params.name)
      sandboxes.set(params.name, sandbox)
      return sandbox
    }
  }
  return { client: client as unknown as Daytona, calls }
}

let root: string
beforeEach(async () => (root = await mkdtemp(join(tmpdir(), "pi-cloud-daytona-"))))
afterEach(() => rm(root, { recursive: true, force: true }))

describe("daytonaSandboxes", () => {
  it("creates one sandbox per key, starts it, and runs commands and file operations through sessions", async () => {
    const { client, calls } = fakeDaytona(root)
    const provider = daytonaSandboxes({ client })
    const handle = await Effect.runPromise(provider.create({ key: "session-1/box", template: { provider: "daytona", cwd: "app" }, env: {} }))
    const again = await Effect.runPromise(provider.create({ key: "session-1/box", template: { provider: "daytona" }, env: {} }))
    expect(again.id).toBe(handle.id)
    expect(calls.filter((call) => call.startsWith("create"))).toEqual(["create session-1/box"])
    expect(handle.cwd).toBe(join(root, "app"))

    const env = await Effect.runPromise(provider.connect(handle, { GREETING: "it's me" }))
    let output = ""
    const result = await env.exec(`echo "$GREETING from $(pwd)"; exit 4`, { onOutput: (text) => (output += text) }, context)
    expect(result).toEqual({ ok: true, value: { exitCode: 4 } })
    expect(output).toBe(`it's me from ${join(root, "app")}\n`)

    expect((await env.writeFile("notes/a.txt", "written natively", context)).ok).toBe(true)
    expect(calls).toContain(`upload ${join(root, "app/notes/a.txt")}`)
    expect(await readFile(join(root, "app/notes/a.txt"), "utf8")).toBe("written natively")
    expect((await env.appendFile("notes/a.txt", " and appended", context)).ok).toBe(true)
    expect(await env.readTextFile("notes/a.txt", context)).toEqual({ ok: true, value: "written natively and appended" })
  })
})
