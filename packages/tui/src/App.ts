import { getSelectListTheme, initTheme } from "@earendil-works/pi-coding-agent"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { Container, Editor, Loader, matchesKey, ProcessTerminal, type Terminal, Text, TuiMainScreen } from "@earendil-works/pi-tui"
import { type ClientOptions, openChannel, type SessionChannel } from "@pi-cloud/client"
import type { CommandResult, SessionCommand } from "@pi-cloud/protocol"
import { serveWorkspace } from "@pi-cloud/workspace"
import { Deferred, Effect, Stream } from "effect"
import { homedir } from "node:os"
import { ChatView, type ChatState } from "./Chat.ts"

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`
const cyan = (text: string) => `\x1b[36m${text}\x1b[39m`

export interface TuiOptions extends ClientOptions {
  readonly sessionId: string
  /** The directory shown in the UI and, with `serve`, the workspace served to the session. */
  readonly cwd: string
  /** Serve this machine's `cwd` as the session's workspace, so the agent's tools run here. */
  readonly serve: boolean
  /** Defaults to the process's terminal. */
  readonly terminal?: Terminal
}

const HELP = [
  "Enter sends; while the agent works it steers the current turn. Esc aborts. Ctrl+C clears, twice quits.",
  "/model provider/model   /thinking level   /compact [instructions]   /reset   /abort   /session   /quit"
].join("\n")

const shortPath = (path: string) => {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const formatTokens = (count: number) =>
  count < 1_000 ? `${count}` : count < 1_000_000 ? `${(count / 1_000).toFixed(1)}k` : `${(count / 1_000_000).toFixed(1)}M`

const footerText = (state: ChatState, options: TuiOptions, connected: boolean) => {
  let input = 0
  let output = 0
  let cost = 0
  for (const usage of Object.values(state.usage?.models ?? {}) as Array<any>) {
    input += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
    output += usage.output ?? 0
    cost += usage.cost?.total ?? 0
  }
  const model = state.agent?.model === undefined ? "" : `${state.agent.model.provider}/${state.agent.model.modelId}`
  return dim([
    shortPath(options.cwd),
    model + (state.agent?.thinkingLevel === undefined ? "" : ` · ${state.agent.thinkingLevel}`),
    `↑${formatTokens(input)} ↓${formatTokens(output)} $${cost.toFixed(3)}`,
    connected ? options.sessionId : "reconnecting…"
  ].filter(Boolean).join("  "))
}

/**
 * Pi's terminal experience for a pi-cloud session. The conversation renders with Pi's own components, and with
 * `serve` the agent's file and shell tools run in `cwd` on this machine, as with a local `pi`. The agent loop,
 * model credentials and history live on the server: quit and reattach any time, from anywhere.
 */
export const runTui = (options: TuiOptions): Promise<void> => {
  initTheme()
  const terminal = options.terminal ?? new ProcessTerminal()
  const ui = new TuiMainScreen(terminal)
  let state: ChatState = { running: false }
  let connected = false
  const footer = new Text("", 1, 0)
  const status = new Container()
  let loader: Loader | undefined
  const refresh = () => {
    footer.setText(footerText(state, options, connected))
    if (state.running && loader === undefined) {
      loader = new Loader(ui, cyan, dim, "Working… (esc to interrupt)")
      status.addChild(loader)
    } else if (!state.running && loader !== undefined) {
      loader.stop()
      status.removeChild(loader)
      loader = undefined
    }
    ui.requestRender()
  }
  const chat = new ChatView(ui, options.cwd, (next) => {
    state = next
    refresh()
  })
  const editor = new Editor(ui, { borderColor: dim, selectList: getSelectListTheme() })

  ui.addChild(new Text(`${cyan("pi-cloud")} ${dim(`· ${options.serve ? `tools run in ${shortPath(options.cwd)}` : "attached"} · /help`)}`, 1, 1))
  ui.addChild(chat.container)
  ui.addChild(status)
  ui.addChild(editor)
  ui.addChild(footer)
  ui.setFocus(editor)
  refresh()
  ui.start()

  const workspace = options.serve ? serveWorkspace(new NodeExecutionEnv({ cwd: options.cwd })) : undefined
  let channel: SessionChannel | undefined
  let position: string | undefined

  return Effect.runPromise(Effect.gen(function*() {
    const quit = yield* Deferred.make<void>()
    const exit = () => Effect.runSync(Deferred.succeed(quit, undefined))

    const run = (command: SessionCommand) => {
      if (channel === undefined) return chat.notice("Not connected yet", "error")
      Effect.runPromise(channel.command(command)).then(
        (result: CommandResult) => {
          if (result._tag === "Err") chat.notice(`${result.tag}: ${result.message}`, "error")
        },
        (error) => chat.notice(`Failed to send: ${error}`, "error")
      )
    }

    const slash = (line: string) => {
      const [name, ...args] = line.slice(1).split(/\s+/)
      const rest = args.join(" ")
      switch (name) {
        case "model": {
          const [provider, ...model] = rest.split("/")
          if (!provider || model.length === 0) return chat.notice("Usage: /model provider/model", "error")
          return run({ _tag: "Configure", model: { provider, modelId: model.join("/") } })
        }
        case "thinking":
          return run({ _tag: "Configure", thinkingLevel: rest || null })
        case "compact":
          return run({ _tag: "Compact", ...(rest ? { instructions: rest } : {}) })
        case "reset":
          return run({ _tag: "Reset" })
        case "abort":
          return run({ _tag: "Abort" })
        case "session":
          return chat.notice(`Session ${options.sessionId}`)
        case "help":
          return chat.notice(HELP)
        case "quit":
        case "exit":
          return exit()
        default:
          return chat.notice(`Unknown command /${name}. /help lists them.`, "error")
      }
    }

    editor.onSubmit = (text) => {
      const line = text.trim()
      if (line.length === 0) return
      editor.addToHistory(line)
      if (line.startsWith("/")) return slash(line)
      run({ _tag: "Prompt", content: line, whenBusy: "steer" })
    }

    let interrupted = 0
    ui.addInputListener((data) => {
      if (matchesKey(data, "escape") && state.running) {
        run({ _tag: "Abort" })
        return { consume: true }
      }
      if (matchesKey(data, "ctrl+c")) {
        if (editor.getText().length > 0) editor.setText("")
        else if (Date.now() - interrupted < 1_000) exit()
        else {
          interrupted = Date.now()
          chat.notice("Press Ctrl+C again to quit")
        }
        return { consume: true }
      }
      if (matchesKey(data, "ctrl+d") && editor.getText().length === 0) {
        exit()
        return { consume: true }
      }
      return undefined
    })

    // Stay attached: reconnect after drops, resuming the event stream where it stopped.
    const attach = Effect.scoped(Effect.gen(function*() {
      const opened = yield* openChannel({ ...options, sessionId: options.sessionId, after: position, workspace })
      channel = opened
      connected = true
      refresh()
      yield* opened.events.pipe(Stream.runForEach((batch) =>
        Effect.sync(() => {
          position = `${batch.epoch}:${batch.seq}`
          for (const event of batch.events) chat.apply(event as never)
        })
      ))
    })).pipe(
      Effect.catch((error) => Effect.sync(() => chat.notice(`Connection failed: ${error}`, "error"))),
      Effect.andThen(Effect.sync(() => {
        channel = undefined
        connected = false
        refresh()
      })),
      Effect.andThen(Effect.sleep(1_000)),
      Effect.forever
    )

    yield* Effect.raceFirst(attach, Deferred.await(quit))
  })).finally(async () => {
    ui.stop()
    await workspace?.close()
  })
}
