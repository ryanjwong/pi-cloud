import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { PiCloud } from "@pi-cloud/client"
import { piAgent } from "@pi-cloud/pi"
import { extensions, modelProviders } from "@pi-cloud/runner"
import { sandboxes } from "@pi-cloud/sandbox"
import { localSandboxes } from "@pi-cloud/sandbox-local"
import { runTui, type Terminal } from "@pi-cloud/tui"
import xterm from "@xterm/headless"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

let deployment: LocalDeployment | undefined
let root: string | undefined
afterEach(async () => {
  await deployment?.stop()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  deployment = undefined
  root = undefined
})

/** A terminal emulated in memory: the TUI draws into it, the test reads its screen and types. */
const fakeTerminal = () => {
  const emulator = new xterm.Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  let input: ((data: string) => void) | undefined
  const terminal: Terminal = {
    start: (onInput) => void (input = onInput),
    stop: () => {},
    drainInput: async () => {},
    write: (data) => emulator.write(data),
    get columns() {
      return 120
    },
    get rows() {
      return 40
    },
    kittyProtocolActive: false,
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
    setProgramStatus: () => {}
  }
  const screen = () => {
    const buffer = emulator.buffer.active
    const lines: Array<string> = []
    for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? "")
    return lines.join("\n").replace(/\s+$/, "")
  }
  return { terminal, screen, type: (data: string) => input?.(data) }
}

const until = async (check: () => boolean, what: string, screen: () => string) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${what}; screen:\n${screen()}`)
}

describe("Pi's TUI on a cloud session", () => {
  it("renders the cloud agent working in a clone of the repository", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-cloud-tui-"))
    // The developer's repository, standing in for its origin.
    const origin = join(root, "origin")
    await mkdir(origin)
    const git = (...args: Array<string>) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: origin, stdio: "pipe" })
    git("init", "--quiet", "-b", "main")
    await writeFile(join(origin, "README.md"), "hello from the repository\n")
    await writeFile(join(origin, "AGENTS.md"), "Always run the tests before answering.\n")
    git("add", ".")
    git("commit", "--quiet", "-m", "init")

    const faux = fauxProvider()
    let prompt = ""
    faux.setResponses([
      (context) => {
        prompt = JSON.stringify(context)
        return fauxAssistantMessage(fauxToolCall("bash", { command: "cat README.md && echo made > made.txt" }), {
          stopReason: "toolUse"
        })
      },
      fauxAssistantMessage("The readme says hello.")
    ])
    const cloud = join(root, "cloud")
    deployment = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      runner: {
        idleMs: 5_000,
        plugins: [
          modelProviders(faux.provider),
          extensions("coding", CodingTools),
          piAgent(),
          sandboxes({ providers: [localSandboxes({ root: cloud })] })
        ]
      }
    })
    const url = deployment.url
    // What `pi-cloud` creates in a checkout: a session whose sandbox clones the origin at the current branch.
    const session = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* PiCloud
      return yield* client.sessions.create({
        payload: {
          spec: {
            model: { provider: "faux", modelId: "faux-1" },
            sandbox: "home",
            sandboxes: { home: { provider: "local", repository: { url: `file://${origin}`, ref: "main" } } }
          }
        }
      })
    }).pipe(Effect.provide(PiCloud.layer({ url }))))

    const { terminal, screen, type } = fakeTerminal()
    const done = runTui({ url, sessionId: session.id, label: "acme/api@main", terminal })
    try {
      await until(() => screen().includes("acme/api@main"), "the footer", screen)
      expect(screen()).toContain("faux/faux-1")

      for (const key of "what does the readme say?") type(key)
      type("\r")
      await until(() => screen().includes("The readme says hello."), "the answer", screen)
      const shown = screen()
      if (process.env.SCREEN_DIR) await writeFile(join(process.env.SCREEN_DIR, "pi-tui.txt"), shown)
      expect(shown).toContain("what does the readme say?")
      expect(shown).toContain("cat README.md && echo made > made.txt")
      expect(shown).toContain("hello from the repository")

      // The agent ran in the cloud: in a clone of the origin, with Pi's system prompt reading its AGENTS.md.
      const sandbox = join(cloud, `${session.id}_home`)
      expect(await readFile(join(sandbox, "made.txt"), "utf8")).toBe("made\n")
      expect(existsSync(join(origin, "made.txt"))).toBe(false)
      expect(prompt).toContain("Always run the tests before answering.")
    } finally {
      // Pi's clear key exits the durable TUI.
      type("\x03")
      await done
    }

    // Attaching again, from anywhere, shows the same conversation.
    const again = fakeTerminal()
    const reattached = runTui({ url, sessionId: session.id, label: "acme/api@main", terminal: again.terminal })
    try {
      await until(() => again.screen().includes("The readme says hello."), "the history", again.screen)
      expect(again.screen()).toContain("hello from the repository")
    } finally {
      again.type("\x03")
      await reattached
    }

  }, 60_000)

  it("switches thinking levels and models through the API", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-cloud-tui-"))
    const faux = fauxProvider({ models: [{ id: "deep", reasoning: true }, { id: "plain" }] })
    deployment = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      runner: {
        idleMs: 5_000,
        plugins: [modelProviders(faux.provider), extensions("coding", CodingTools), sandboxes({ providers: [localSandboxes({ root })] })]
      }
    })
    const url = deployment.url
    const session = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* PiCloud
      return yield* client.sessions.create({
        payload: { spec: { model: { provider: "faux", modelId: "deep" }, sandbox: "home", sandboxes: { home: { provider: "local" } } } }
      })
    }).pipe(Effect.provide(PiCloud.layer({ url }))))

    const { terminal, screen, type } = fakeTerminal()
    const done = runTui({ url, sessionId: session.id, label: "scratch", terminal })
    try {
      await until(() => screen().includes("faux/deep · thinking:off"), "the footer", screen)
      // Pi's thinking key cycles through the levels the session state lists for the model.
      type("\x1b[Z")
      await until(() => /faux\/deep · thinking:(?!off)/.test(screen()), "a thinking level", screen)
      // /model opens Pi's model picker over the session's models; the runner clamps thinking for the new model.
      for (const key of "/model") type(key)
      type("\r")
      await until(() => screen().includes("Select model:"), "the model picker", screen)
      for (const key of "plain") type(key)
      type("\r")
      await until(() => screen().includes("faux/plain · thinking:off"), "the new model", screen)
      type("\x1b[Z")
      await until(() => screen().includes("Current model does not support thinking"), "the notice", screen)
    } finally {
      type("\x03")
      await done
    }
  }, 60_000)

  it("switches to a subagent's conversation with /agents", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-cloud-tui-"))
    const faux = fauxProvider()
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("subagent", { task: "count the files" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("There are three files."),
      fauxAssistantMessage("The subagent counted three files.")
    ])
    deployment = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      runner: {
        idleMs: 5_000,
        plugins: [
          modelProviders(faux.provider),
          extensions("coding", CodingTools),
          piAgent(),
          sandboxes({ providers: [localSandboxes({ root })] })
        ]
      }
    })
    const url = deployment.url
    const session = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* PiCloud
      return yield* client.sessions.create({
        payload: { spec: { model: { provider: "faux", modelId: "faux-1" }, sandbox: "home", sandboxes: { home: { provider: "local" } } } }
      })
    }).pipe(Effect.provide(PiCloud.layer({ url }))))

    const { terminal, screen, type } = fakeTerminal()
    const done = runTui({ url, sessionId: session.id, terminal })
    try {
      await until(() => screen().includes("faux/faux-1"), "the footer", screen)
      for (const key of "delegate it") type(key)
      type("\r")
      await until(() => screen().includes("The subagent counted three files."), "the answer", screen)
      for (const key of "/agents") type(key)
      type("\r")
      await until(() => screen().includes("Switch to:"), "the conversation picker", screen)
      for (const key of "subagent") type(key)
      type("\r")
      await until(() => /subagent \d+ · faux\/faux-1/.test(screen()), "the subagent's footer", screen)
      expect(screen()).toContain("count the files")
      expect(screen()).toContain("There are three files.")
    } finally {
      type("\x03")
      await done
    }
  }, 60_000)
})
