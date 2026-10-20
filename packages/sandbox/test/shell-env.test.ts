import type { Context } from "@earendil-works/chord"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { execFileSync, spawn } from "node:child_process"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type RemoteShell, shellEnv } from "../src/ShellEnv.ts"

const context = {} as Context
const withSignal = (signal: AbortSignal) => ({ abortSignal: signal }) as unknown as Context

/** A `RemoteShell` that is a local `sh`: the shell-backed environment, minus the network. */
const localShell = (options: { stdin: boolean }): RemoteShell => ({
  id: "test:local-shell",
  stdin: options.stdin,
  run: (script, run) =>
    new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", script], {
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tmpdir(), ...run.env },
        stdio: [run.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      })
      child.stdout?.on("data", (chunk: Buffer) => run.onStdout?.(new Uint8Array(chunk)))
      child.stderr?.on("data", (chunk: Buffer) => run.onStderr?.(new Uint8Array(chunk)))
      run.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true })
      child.on("error", reject)
      child.on("close", (code) => resolve(code ?? 137))
      if (run.stdin !== undefined) child.stdin?.end(run.stdin)
    })
})

let root: string
beforeEach(async () => (root = await mkdtemp(join(tmpdir(), "pi-cloud-shell-env-"))))
afterEach(() => rm(root, { recursive: true, force: true }))

const binary = new Uint8Array(70_000).map((_, index) => (index * 7) % 256)

/** Every file operation, run the same way on an environment. Results are normalized for comparison. */
const exercise = async (env: ExecutionEnv, dir: string) => {
  const code = <A>(result: { ok: true; value: A } | { ok: false; error: { code: string } }) =>
    result.ok ? { ok: result.value } : { error: result.error.code }
  const results: Record<string, unknown> = {}
  await env.createDir(join(dir, "a/b"), { recursive: true }, context)
  results.write = code(await env.writeFile(join(dir, "a/b/text.txt"), "one\ntwo\nthree", context))
  results.append = code(await env.appendFile(join(dir, "a/b/text.txt"), "\nfour\n", context))
  results.text = code(await env.readTextFile("a/b/text.txt", context))
  results.lines = code(await env.readTextLines(join(dir, "a/b/text.txt"), { maxLines: 2 }, context))
  results.writeNested = code(await env.writeFile(join(dir, "new/deeper/file"), "x", context))
  results.appendNested = code(await env.appendFile(join(dir, "other/deeper/file"), "x", context))
  await env.writeFile(join(dir, "bin"), binary, context)
  const read = await env.readBinaryFile(join(dir, "bin"), context)
  results.binary = read.ok && Buffer.from(read.value).equals(Buffer.from(binary))
  const info = await env.fileInfo(join(dir, "a/b/text.txt"), context)
  results.info = info.ok ? { name: info.value.name, path: info.value.path, kind: info.value.kind, size: info.value.size } : info
  results.dirInfo = code(await env.fileInfo(join(dir, "a"), context)).ok !== undefined
  const listed = await env.listDir(dir, context)
  results.list = listed.ok ? listed.value.map((entry) => `${entry.kind}:${entry.name}`).sort() : listed
  results.missing = code(await env.readTextFile(join(dir, "nope"), context))
  results.readDir = code(await env.readTextFile(join(dir, "a"), context))
  results.listFile = code(await env.listDir(join(dir, "bin"), context))
  results.exists = [code(await env.exists(join(dir, "bin"), context)), code(await env.exists(join(dir, "nope"), context))]
  results.rename = code(await env.renameFile(join(dir, "bin"), join(dir, "a/moved"), context))
  results.renamed = [code(await env.exists(join(dir, "bin"), context)), code(await env.exists(join(dir, "a/moved"), context))]
  results.truncate = code(await env.truncateFile(join(dir, "a/moved"), 10, context))
  results.truncated = code(await env.fileInfo(join(dir, "a/moved"), context))
  results.truncated = (results.truncated as { ok?: { size: number } }).ok?.size
  await symlink(join(dir, "a/b"), join(dir, "link"))
  results.canonical = code(await env.canonicalPath(join(dir, "link/text.txt"), context))
  results.linkInfo = ((await env.fileInfo(join(dir, "link"), context)) as { value?: { kind: string } }).value?.kind
  const reader = await env.openBinaryReader(join(dir, "a/b/text.txt"), undefined, context)
  results.scan = reader.ok ? code(await reader.value.scanLines({ startLine: 1, endLine: 3 }, context)) : reader
  results.slice = reader.ok ? code(await reader.value.read(4, 3, context)) : reader
  results.slice = Array.from((results.slice as { ok: Uint8Array }).ok)
  results.noFollow = code(await env.openBinaryReader(join(dir, "link"), { noFollow: true }, context))
  results.mkdirExisting = code(await env.createDir(join(dir, "a"), { recursive: false }, context))
  results.mkdirNoParent = code(await env.createDir(join(dir, "x/y"), { recursive: false }, context))
  results.removeDir = code(await env.remove(join(dir, "a"), undefined, context))
  results.removeMissing = [code(await env.remove(join(dir, "nope"), undefined, context)), code(await env.remove(join(dir, "nope"), { force: true }, context))]
  results.removeTree = code(await env.remove(join(dir, "a"), { recursive: true }, context))
  results.afterRemove = code(await env.exists(join(dir, "a"), context))
  const temp = await env.createTempFile({ prefix: "p-", suffix: ".log" }, context)
  results.temp = temp.ok && temp.value.endsWith(".log") && code(await env.exists(temp.value, context))
  return results
}

describe("shellEnv", () => {
  for (const stdin of [true, false]) {
    it(`matches Pi's Node environment for file operations (${stdin ? "stdin" : "base64"} writes)`, async () => {
      const expected = await exercise(new NodeExecutionEnv({ cwd: join(root, "node") }), join(root, "node"))
      const actual = await exercise(shellEnv(localShell({ stdin }), { cwd: join(root, "shell") }), join(root, "shell"))
      // Error codes, contents, kinds and sizes agree; paths differ only by the directory they ran in. Removing a
      // directory without `recursive` is the one refinement: Node reports it as unknown.
      const normalized = JSON.parse(JSON.stringify(actual).replaceAll(join(root, "shell"), join(root, "node")))
      expect(normalized.removeDir).toEqual({ error: "is_directory" })
      expect({ ...normalized, removeDir: { error: "unknown" } }).toEqual(JSON.parse(JSON.stringify(expected)))
      expect(expected.missing).toEqual({ error: "not_found" })
      expect(expected.readDir).toEqual({ error: "is_directory" })
    })
  }

  it("runs commands with their environment, working directory, and streamed output", async () => {
    const env = shellEnv(localShell({ stdin: true }), { cwd: root, env: { FROM_TEMPLATE: "template" } })
    await env.createDir(join(root, "sub"), undefined, context)
    const output: Array<string> = []
    const result = await env.exec(
      `echo "$FROM_TEMPLATE $FROM_CALL $(pwd)"; echo oops >&2; exit 3`,
      { cwd: "sub", env: { FROM_CALL: "call" }, onOutput: (text, _context, info) => output.push(`${info.stream}:${text}`) },
      context
    )
    expect(result).toEqual({ ok: true, value: { exitCode: 3 } })
    expect(output.sort()).toEqual([`stderr:oops\n`, `stdout:template call ${join(root, "sub")}\n`])

    const argv: Array<string> = []
    await env.exec(["printf", "%s|", "a b", "it's"], { onOutput: (text) => argv.push(text) }, context)
    expect(argv.join("")).toBe("a b|it's|")

    const missing = await env.exec("true", { cwd: "nowhere" }, context)
    expect(missing.ok ? missing : missing.error.code).toBe("spawn_error")
  })

  it("kills the whole process tree on timeout and abort", async () => {
    const env = shellEnv(localShell({ stdin: true }), { cwd: root })
    const marker = `pi-cloud-test-${process.pid}-${Date.now()}`
    const started = Date.now()
    const timedOut = await env.exec(`sleep 30 & sh -c 'exec sleep 31' & echo ${marker} >/dev/null; wait`, { timeout: 1 }, context)
    expect(timedOut.ok ? timedOut : timedOut.error.code).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(8_000)

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const aborted = await env.exec(`(sleep 32; echo late) & sleep 33`, undefined, withSignal(controller.signal))
    expect(aborted.ok ? aborted : aborted.error.code).toBe("aborted")
    await new Promise((resolve) => setTimeout(resolve, 300))
    const left = execFileSync("sh", ["-c", "ps -eo args | grep -E '^sleep 3[0-3]$' || true"]).toString().trim()
    expect(left).toBe("")
  }, 20_000)

  it("spills large output to a file inside the sandbox", async () => {
    const env = shellEnv(localShell({ stdin: false }), { cwd: root })
    const result = await env.exec(`seq 1 50000`, { spill: { afterBytes: 1_000, afterLines: 100 } }, context)
    expect(result.ok).toBe(true)
    const spillPath = result.ok ? result.value.spillPath : undefined
    expect(spillPath).toBeDefined()
    const spilled = await env.readTextFile(spillPath!, context)
    expect(spilled.ok && spilled.value.split("\n").length).toBe(50_001)

    const small = await env.exec(`echo hi`, { spill: { afterBytes: 1_000, afterLines: 100 } }, context)
    expect(small).toEqual({ ok: true, value: { exitCode: 0 } })
  })
})
