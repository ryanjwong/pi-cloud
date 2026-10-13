import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { ConversationId, ConversationView, ModelRef } from "@earendil-works/pi-durable"
import {
  type AttachedSession,
  type ClientOptions,
  type Conversation,
  Conversations,
  connectServices,
  Models,
  Notices,
  type ServiceConnection,
  Tasks
} from "@pi-cloud/client"
import type { ConversationSummary, DurableController, DurableView, DurableViewSource, Notice } from "./pi/View.ts"

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
  /** Resolves once the session's services have their state. */
  readonly ready: Promise<void>
  close(): Promise<void>
}

/**
 * Pi's durable TUI contract (`DurableViewSource`, `DurableController`) projected from the service API: every value
 * is a Chord replicated state of a session service, every action a service call. Nothing runs locally but
 * rendering.
 */
export const project = (options: ProjectionOptions): Projection => {
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  const conversations = new Map<number, Conversation>()
  let shown: ConversationId = ROOT
  let showTasks = true
  let local: Array<Notice> = []
  let nextLocal = 1_000_000
  const notice = (level: Notice["level"], message: string) => {
    local = [...local, { id: nextLocal++, level, message }].slice(-20)
    notify()
  }

  let connection: ServiceConnection | undefined
  let attached: AttachedSession | undefined
  const unsubscribes: Array<() => void> = []
  const watch = (state: { subscribe(listener: () => void): () => void }) => unsubscribes.push(state.subscribe(() => notify()))

  const ready = (async () => {
    connection = await connectServices({ url: options.url, apiKey: options.apiKey })
    attached = await connection.attach(options.sessionId)
    const services = attached.services
    watch(services.use(Models).state)
    watch(services.use(Notices).state)
    watch(services.use(Tasks).state)
    // One instance per conversation; a re-subscription after a runner change delivers fresh instances.
    unsubscribes.push(services.observe(Conversations, (conversation) => {
      const id = conversation.summary.value?.id
      if (id === undefined) return
      conversations.set(id, conversation)
      watch(conversation.summary)
      watch(conversation.state)
      notify()
    }))
    await services.ready(BACKGROUND_CONTEXT)
    while (conversations.get(ROOT)?.state.value === undefined) await new Promise((resolve) => setTimeout(resolve, 20))
  })()

  const current = (): Conversation => conversations.get(shown) ?? conversations.get(ROOT)!

  const source: DurableViewSource = {
    current: (): DurableView => {
      const services = attached!.services
      const models = services.use(Models).state.value
      const tasks = services.use(Tasks).state.value
      const summaries: Array<ConversationSummary> = [...conversations.values()]
        .map((conversation) => conversation.summary.value!)
        .filter((summary) => summary !== undefined)
        .sort((a, b) => a.id - b.id)
        .map((summary) => ({ id: summary.id as ConversationId, label: summary.label, ...(summary.title === null ? {} : { title: summary.title }) }))
      return {
        session: { id: options.sessionId, directory: "", cwd: options.label ?? options.sessionId },
        conversation: current().state.value as ConversationView,
        conversations: summaries,
        models: (models?.catalog.availableModels ?? []).map((model) => ({
          provider: model.provider,
          modelId: model.modelId,
          name: model.name,
          contextWindow: model.contextWindow ?? 0
        })),
        notices: [...(services.use(Notices).state.value?.notices ?? []), ...local],
        ...(showTasks && tasks !== undefined ? { tasks } : {})
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }

  const act = (operation: (conversation: Conversation) => Promise<unknown>): Promise<void> =>
    operation(current()).then(
      (response) => {
        const error = (response as { accepted?: boolean; error?: { message: string } } | undefined)?.error
        if (error != null) notice("error", error.message)
      },
      (error) => notice("error", error instanceof Error ? error.message : String(error))
    )

  const controller: DurableController = {
    submit: (text, whenBusy) =>
      act((conversation) =>
        whenBusy === "steer"
          ? conversation.steer({ message: text, images: null }, BACKGROUND_CONTEXT)
          : conversation.followUp({ message: text, images: null }, BACKGROUND_CONTEXT)
      ),
    compact: (instructions) => act((conversation) => conversation.compact({ customInstructions: instructions ?? null }, BACKGROUND_CONTEXT)),
    abort: () => act((conversation) => conversation.abort(BACKGROUND_CONTEXT)),
    cycleThinking: () => act((conversation) => conversation.cycleThinking(BACKGROUND_CONTEXT)),
    setModel: (model: ModelRef) => act((conversation) => conversation.selectModel(model, BACKGROUND_CONTEXT)),
    toggleTasks: async () => {
      showTasks = !showTasks
      notify()
    },
    switchConversation: async (id) => {
      if (!conversations.has(id)) return notice("error", `Conversation ${id} is not available`)
      shown = id
      notify()
    }
  }

  return {
    source,
    controller,
    ready,
    close: async () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
      await attached?.detach().catch(() => {})
      await connection?.close().catch(() => {})
    }
  }
}
