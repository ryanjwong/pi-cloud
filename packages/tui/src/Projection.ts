import type { ConversationId, ConversationView, ModelRef } from "@earendil-works/pi-durable"
import type { ClientOptions, CommandResult, SessionChannel, SessionCommand, ViewNotice } from "@pi-cloud/client"
import { openChannel, ViewReplica } from "@pi-cloud/client"
import { Effect, Fiber, Stream } from "effect"
import { agentOf, type DurableController, type DurableView, type DurableViewSource } from "./pi/View.ts"

/** Pi Durable's root conversation. */
const ROOT = 1 as ConversationId

export interface ProjectionOptions extends ClientOptions {
  readonly sessionId: string
  /** Where the session's code lives, shown in the footer, e.g. `acme/api@main`. */
  readonly label?: string
}

export interface Projection {
  readonly source: DurableViewSource
  readonly controller: DurableController
  /** Resolves once the session state and the root conversation's view have arrived. */
  readonly ready: Promise<void>
  close(): Promise<void>
}

/**
 * Pi's durable TUI contract (`DurableViewSource`, `DurableController`) implemented on the public API alone: the view
 * comes from the session channel's `Watch`, every action is a session command. Nothing runs locally but rendering;
 * the session stays connected across drops.
 */
export const project = (options: ProjectionOptions): Projection => {
  const replica = new ViewReplica()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  replica.subscribe(notify)

  let channel: SessionChannel | undefined
  let shown: ConversationId = ROOT
  let showTasks = true
  let local: Array<ViewNotice> = []
  let nextLocal = 1_000_000
  const notice = (level: ViewNotice["level"], message: string) => {
    local = [...local, { id: nextLocal++, level, message }].slice(-20)
    notify()
  }

  let markReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => (markReady = resolve))
  const checkReady = () => {
    if (replica.session !== undefined && replica.conversation(ROOT) !== undefined) markReady()
  }
  replica.subscribe(checkReady)

  // Stay attached: reconnect after drops and watch again what was watched.
  const connection = Effect.scoped(Effect.gen(function*() {
    const opened = yield* openChannel({ url: options.url, apiKey: options.apiKey, sessionId: options.sessionId })
    yield* opened.errors.pipe(Stream.runForEach((message) => Effect.sync(() => notice("error", message))), Effect.forkScoped)
    const views = yield* opened.views.pipe(Stream.runForEach((update) => Effect.sync(() => replica.apply(update))), Effect.forkScoped)
    yield* opened.watch(ROOT)
    if (shown !== ROOT) yield* opened.watch(shown)
    channel = opened
    yield* Fiber.join(views)
  })).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.andThen(Effect.sync(() => {
      channel = undefined
    })),
    Effect.andThen(Effect.sleep(1_000)),
    Effect.forever
  )
  const fiber = Effect.runFork(connection)

  const run = (command: SessionCommand): Promise<void> => {
    const current = channel
    if (current === undefined) {
      notice("error", "Not connected to the session; retrying.")
      return Promise.resolve()
    }
    return Effect.runPromise(current.command(command)).then(
      (result: CommandResult) => {
        if (result._tag === "Err") notice("error", result.message)
      },
      (error) => notice("error", `Failed to send: ${error}`)
    )
  }

  const shownView = () => replica.conversation<ConversationView>(shown) ?? replica.conversation<ConversationView>(ROOT)!

  const source: DurableViewSource = {
    current: (): DurableView => {
      const session = replica.session ?? { conversations: [], models: [], notices: [] }
      return {
        session: { id: options.sessionId, directory: "", cwd: options.label ?? options.sessionId },
        conversation: shownView(),
        conversations: session.conversations,
        models: session.models,
        notices: [...session.notices, ...local],
        ...(showTasks && session.tasks !== undefined ? { tasks: session.tasks as never } : {})
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }

  const controller: DurableController = {
    submit: (text, whenBusy) => run({ _tag: "Prompt", conversationId: shown, content: text, whenBusy }),
    compact: (instructions) =>
      run({ _tag: "Compact", conversationId: shown, ...(instructions === undefined ? {} : { instructions }) }),
    abort: () => run({ _tag: "Abort", conversationId: shown }),
    // The levels come from the session state's model list, so cycling needs no extra round trip.
    cycleThinking: async () => {
      const agent = agentOf(shownView())
      const model = replica.session?.models.find((candidate) =>
        candidate.provider === agent.model?.provider && candidate.modelId === agent.model?.modelId
      )
      if (model === undefined) return notice("error", agent.model === undefined ? "No model selected" : "Current model is unavailable")
      if (model.thinkingLevels.length <= 1) return notice("error", "Current model does not support thinking")
      const levels = model.thinkingLevels
      const next = levels[(levels.indexOf(agent.thinkingLevel ?? "off") + 1) % levels.length] ?? "off"
      return run({ _tag: "Configure", conversationId: shown, thinkingLevel: next })
    },
    // The runner keeps the thinking level, clamped to the new model.
    setModel: (model: ModelRef) => run({ _tag: "Configure", conversationId: shown, model }),
    toggleTasks: async () => {
      showTasks = !showTasks
      notify()
    },
    switchConversation: async (id) => {
      const current = channel
      if (current === undefined) return notice("error", "Not connected to the session; retrying.")
      if (replica.conversation(id) === undefined) {
        await Effect.runPromise(current.watch(id)).catch(() => {})
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 10_000)
          const unsubscribe = replica.subscribe(() => replica.conversation(id) !== undefined && done())
          function done() {
            clearTimeout(timer)
            unsubscribe()
            resolve()
          }
        })
        if (replica.conversation(id) === undefined) return notice("error", `Conversation ${id} did not load`)
      }
      shown = id
      notify()
    }
  }

  return {
    source,
    controller,
    ready,
    close: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => {})
  }
}
