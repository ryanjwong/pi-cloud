import type { ConversationId, ConversationView, ModelRef } from "@earendil-works/pi-durable"
import { type ClientOptions, connectServices, type Followed, follow, type ServiceConnection } from "@pi-cloud/client"
import type { ConversationSummary, DurableController, DurableView, DurableViewSource, Notice } from "./pi/View.ts"

const ROOT = 1 as ConversationId

export interface ProjectionOptions extends ClientOptions {
  readonly sessionId: string
  readonly label?: string
}

export interface Projection {
  readonly source: DurableViewSource
  readonly controller: DurableController
  readonly ready: Promise<void>
  close(): Promise<void>
}

type Ref<T> = T extends Followed<infer R> ? R : never
type SessionRef = Ref<Awaited<ReturnType<typeof followSession>>>
type ConversationRef = Ref<Awaited<ReturnType<typeof followConversation>>>
const followSession = (connection: ServiceConnection, id: string) => follow(() => connection.session(id))
const followConversation = (connection: ServiceConnection, id: string, conversation: number) =>
  follow(() => connection.conversation(id, conversation))

export const project = (options: ProjectionOptions): Projection => {
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  let showTasks = true
  let local: Array<Notice> = []
  let nextLocal = 1_000_000
  const notice = (level: Notice["level"], message: string) => {
    local = [...local, { id: nextLocal++, level, message }].slice(-20)
    notify()
  }

  let connection: ServiceConnection | undefined
  let session: Followed<SessionRef> | undefined
  let shown: { readonly id: ConversationId; readonly followed: Followed<ConversationRef> } | undefined
  const subscriptions = new Map<object, Array<() => void>>()

  const observe = <R>(followed: Followed<R>, members: (ref: R) => ReadonlyArray<{ subscribe(listener: () => void): () => void }>) => {
    const attach = (ref: R) => {
      for (const unsubscribe of subscriptions.get(followed) ?? []) unsubscribe()
      subscriptions.set(followed, members(ref).map((member) => member.subscribe(() => notify())))
      notify()
    }
    attach(followed.current)
    followed.onChange(attach)
  }
  const stopObserving = (followed: object) => {
    for (const unsubscribe of subscriptions.get(followed) ?? []) unsubscribe()
    subscriptions.delete(followed)
  }

  const show = async (id: ConversationId) => {
    const followed = await followConversation(connection!, options.sessionId, id)
    observe(followed, (ref) => [ref.view, ref.summary])
    const previous = shown
    shown = { id, followed }
    if (previous !== undefined) {
      stopObserving(previous.followed)
      previous.followed.release()
    }
    notify()
  }

  const ready = (async () => {
    connection = await connectServices({ url: options.url, apiKey: options.apiKey })
    session = await followSession(connection, options.sessionId)
    observe(session, (ref) => [ref.conversations, ref.models, ref.tasks, ref.notices])
    await show(ROOT)
  })()

  const source: DurableViewSource = {
    current: (): DurableView => {
      const ref = session!.current
      const summaries: Array<ConversationSummary> = ref.conversations.value
        .map((summary) => ({ id: summary.id as ConversationId, label: summary.label, ...(summary.title === null ? {} : { title: summary.title }) }))
        .sort((a, b) => a.id - b.id)
      return {
        session: { id: options.sessionId, directory: "", cwd: options.label ?? options.sessionId },
        conversation: shown!.followed.current.view.value as ConversationView,
        conversations: summaries,
        models: ref.models.value.availableModels.map((model) => ({
          provider: model.provider,
          modelId: model.modelId,
          name: model.name,
          contextWindow: model.contextWindow ?? 0
        })),
        notices: [...ref.notices.value, ...local],
        ...(showTasks ? { tasks: ref.tasks.value } : {})
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }

  const act = (operation: (conversation: ConversationRef) => Promise<unknown>): Promise<void> =>
    operation(shown!.followed.current).then(
      (response) => {
        const refused = response as { accepted?: boolean; error?: { message: string } } | undefined
        if (refused?.accepted === false && refused.error !== undefined) notice("error", refused.error.message)
      },
      (error) => notice("error", error instanceof Error ? error.message : String(error))
    )

  const controller: DurableController = {
    submit: (text, whenBusy) =>
      act((conversation) => whenBusy === "steer" ? conversation.steer({ message: text }) : conversation.followUp({ message: text })),
    compact: (instructions) => act((conversation) => conversation.compact(instructions === undefined ? {} : { instructions })),
    abort: () => act((conversation) => conversation.abort()),
    cycleThinking: () => act((conversation) => conversation.cycleThinking()),
    setModel: (model: ModelRef) => act((conversation) => conversation.selectModel(model)),
    toggleTasks: async () => {
      showTasks = !showTasks
      notify()
    },
    switchConversation: async (id) => {
      if (!session!.current.conversations.value.some((summary) => summary.id === id)) {
        return notice("error", `Conversation ${id} is not available`)
      }
      if (shown?.id !== id) await show(id).catch((error) => notice("error", error instanceof Error ? error.message : String(error)))
    }
  }

  return {
    source,
    controller,
    ready,
    close: async () => {
      for (const unsubscribes of subscriptions.values()) for (const unsubscribe of unsubscribes) unsubscribe()
      subscriptions.clear()
      shown?.followed.release()
      session?.release()
      await connection?.close().catch(() => {})
    }
  }
}
