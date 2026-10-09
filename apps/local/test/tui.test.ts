import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import type { Terminal } from "@pi-cloud/tui"
import { PiCloud } from "@pi-cloud/client"
import { extensions, modelProviders } from "@pi-cloud/runner"
import { runTui } from "@pi-cloud/tui"
import { workspace } from "@pi-cloud/workspace/plugin"
import xterm from "@xterm/headless"
import { Effect } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
  /** Everything in the scrollback and on screen, as text. */
  const screen = () => {
    const buffer = emulator.buffer.active
    const lines: Array<string> = []
    for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? "")
    return lines.join("\n").replace(/\n+$/, "")
  }
  const type = (data: string) => input?.(data)
  return { terminal, screen, type }
}

const until = async (check: () => boolean, what: string) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe("TUI", () => {
  it("chats with a session whose tools run in the local checkout", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-cloud-tui-"))
    const faux = fauxProvider()
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo from-the-agent > made.txt && echo bash-output-line" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("All fixed, see made.txt")
    ])
    deployment = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      runner: { idleMs: 5_000, plugins: [modelProviders(faux.provider), extensions("coding", CodingTools), workspace()] }
    })
    const url = deployment.url
    const session = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* PiCloud
      return yield* client.sessions.create({
        payload: { spec: { model: { provider: "faux", modelId: "faux-1" }, workspace: { cwd: root! } } }
      })
    }).pipe(Effect.provide(PiCloud.layer({ url }))))

    const { terminal, screen, type } = fakeTerminal()
    const done = runTui({ url, sessionId: session.id, cwd: root, serve: true, terminal })
    await until(() => screen().includes(session.id), "the footer")

    try {
      type("please fix the build")
      type("\r")
      await until(() => screen().includes("All fixed, see made.txt"), "the answer")
      const shown = screen()
      if (process.env.SCREEN_DIR) await writeFile(join(process.env.SCREEN_DIR, "live.txt"), shown)
      expect(shown.split("please fix the build")).toHaveLength(2)
      expect(shown).toContain("$ echo from-the-agent > made.txt && echo bash-output-line")
      expect(shown).toContain("bash-output-line")
      expect(shown).toContain("faux/faux-1")
      expect(await readFile(join(root, "made.txt"), "utf8")).toBe("from-the-agent\n")
    } finally {
      // Ctrl+C twice quits, closing the channel.
      type("\x03")
      type("\x03")
      await done
    }

    // Reattaching later rebuilds the same conversation from the session's history.
    const again = fakeTerminal()
    const reattached = runTui({ url, sessionId: session.id, cwd: root, serve: true, terminal: again.terminal })
    try {
      await until(() => again.screen().includes("All fixed, see made.txt"), "the history")
      const shown = again.screen()
      if (process.env.SCREEN_DIR) await writeFile(join(process.env.SCREEN_DIR, "reattached.txt"), shown)
      expect(shown.split("please fix the build")).toHaveLength(2)
      expect(shown).toContain("$ echo from-the-agent > made.txt && echo bash-output-line")
      expect(shown).toContain("bash-output-line")
    } finally {
      again.type("\x03")
      again.type("\x03")
      await reattached
    }
  }, 30_000)
})
