import type { AttachedReplicatedState, Context, JsonValue } from "@earendil-works/chord"
import { diffRevisions } from "@earendil-works/chord/delta"
import { clampThinkingLevel, getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai"
import type { Models } from "@earendil-works/pi-ai/models"
import type {
  AgentState,
  ConversationId,
  ConversationView,
  Cursor,
  EntryRecord,
  Harness,
  Submission,
  TaskGraph
} from "@earendil-works/pi-durable"

/** The batch stream presentations render from, next to Pi's agent events. */
export const VIEW_STREAM = "view"
/** The view stream's session-wide state travels as conversation 0, which Pi never uses. */
export const SESSION_VIEW = 0

export interface ViewModel {
  readonly provider: string
  readonly modelId: string
  readonly name: string
  readonly contextWindow: number
  /** Thinking levels the model supports, in order; `["off"]` without reasoning. */
  readonly thinkingLevels: ReadonlyArray<string>
}

export interface ViewNotice {
  readonly id: number
  readonly level: "info" | "warning" | "error"
  readonly message: string
}

/** A conversation the user can switch to: the main one, or a subagent's. */
export interface ViewConversation {
  readonly id: number
  readonly label: string
  /** The first user message; for a subagent, its task. */
  readonly title?: string
}

/** Session-wide state: what Pi's TUI shows besides the conversation itself. */
export interface SessionViewState {
  readonly conversations: ReadonlyArray<ViewConversation>
  readonly models: ReadonlyArray<ViewModel>
  readonly notices: ReadonlyArray<ViewNotice>
  readonly tasks?: TaskGraph
}

/** One event of the view stream: a full value, or Chord delta operations against the previous one. */
export type ViewEvent =
  | { readonly type: "snapshot"; readonly value: JsonValue }
  | { readonly type: "ops"; readonly ops: ReadonlyArray<unknown> }

/** The agent document of a conversation view. */
export const agentOf = (view: ConversationView): AgentState => (view.docs["pi.agent"] ?? {}) as AgentState

const titleOf = (entry: EntryRecord | undefined): { title?: string } => {
  const message = entry?.model?.[0]
  if (message?.role !== "user") return {}
  const text = typeof message.content === "string"
    ? message.content
    : message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(" ")
  return { title: text.replace(/\s+/g, " ").trim() }
}

interface Published {
  value: JsonValue
  readonly dispose: () => void
}

/**
 * Publishes the view Pi's durable TUI renders: each watched conversation's `viewState()` and the session-wide state
 * (conversations, models, notices, task graph), each as a snapshot followed by Chord delta operations. Ported from
 * Pi's own durable runtime, so a presentation sees exactly what a local Pi would show.
 */
export class ViewPublisher {
  readonly #harness: Harness
  readonly #models: Models
  readonly #context: Context
  readonly #send: (conversationId: number, events: ReadonlyArray<ViewEvent>) => void
  readonly #conversations = new Map<number, Published>()
  #session: SessionViewState = { conversations: [], models: [], notices: [] }
  #sessionSent: JsonValue | undefined
  #nextNotice = 1
  #disposers: Array<() => void> = []
  #closed = false

  constructor(
    harness: Harness,
    models: Models,
    context: Context,
    send: (conversationId: number, events: ReadonlyArray<ViewEvent>) => void
  ) {
    this.#harness = harness
    this.#models = models
    this.#context = context
    this.#send = send
  }

  async start(rootId: ConversationId): Promise<void> {
    const label = (id: number) => (id === rootId ? "main" : `subagent ${id}`)
    const conversations: Array<ViewConversation> = []
    let cursor: Cursor | undefined
    do {
      const page = await this.#harness.commit((tx) => tx.scanConversations({}, 256, cursor), this.#context)
      for (const { id } of page.items) conversations.push({ id, label: label(id), ...(await this.#firstInput(id, rootId)) })
      cursor = page.next
    } while (cursor !== undefined)
    this.#session = { ...this.#session, conversations, models: await this.#availableModels() }
    // Subagents appear as their conversations are created.
    this.#disposers.push(this.#harness.subscribeCommits((publication) => {
      let next = this.#session.conversations
      for (const change of publication.changes) {
        if (change.type === "conversation") next = [...next, { id: change.value.id, label: label(change.value.id) }]
        else if (change.type === "entry" && change.value.kind === "pi.user") {
          const id = change.value.conversationId
          next = next.map((summary) => summary.id === id && summary.title === undefined ? { ...summary, ...titleOf(change.value) } : summary)
        }
      }
      if (next !== this.#session.conversations) this.#update({ conversations: next })
    }))
    const tasks: AttachedReplicatedState<TaskGraph> = await this.#harness.taskGraph(this.#context)
    this.#disposers.push(() => tasks.dispose(), tasks.subscribe((value) => this.#update({ tasks: value })))
    this.#session = { ...this.#session, tasks: tasks.value }
    this.#publishSession(true)
    await this.watch(rootId)
    const root = this.#conversations.get(rootId)?.value as unknown as ConversationView | undefined
    const saved = root === undefined ? undefined : agentOf(root).model
    if (saved === undefined) this.notice("warning", "No model configured; select one with /model.")
    else if (this.#models.getModel(saved.provider, saved.modelId) === undefined) {
      this.notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`)
    }
  }

  async #firstInput(id: number, rootId: number): Promise<{ title?: string }> {
    if (id === rootId) return {}
    const conversation = await this.#harness.conversation(id as ConversationId, this.#context)
    if (conversation === undefined) return {}
    let first: EntryRecord | undefined
    let cursor: Cursor | undefined
    do {
      const page = await conversation.entries({}, 256, cursor, this.#context)
      first = page.items.findLast((entry) => entry.kind === "pi.user") ?? first
      cursor = page.next
    } while (cursor !== undefined)
    return titleOf(first)
  }

  async #availableModels(): Promise<Array<ViewModel>> {
    const available = await this.#models.getAvailable().catch(() => [])
    return available.map((model) => ({
      provider: model.provider,
      modelId: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      thinkingLevels: model.reasoning ? getSupportedThinkingLevels(model) : ["off"]
    }))
  }

  /** Start publishing a conversation's view, if not already. */
  async watch(id: number): Promise<void> {
    if (this.#closed || this.#conversations.has(id)) return
    const conversation = await this.#harness.conversation(id as ConversationId, this.#context)
    if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`)
    const state = await conversation.viewState(this.#context)
    const published: Published = { value: state.value as unknown as JsonValue, dispose: () => {} }
    const unsubscribe = state.subscribe((value) => {
      const next = value as unknown as JsonValue
      const ops = diffRevisions(published.value, next)
      published.value = next
      if (ops.length > 0) this.#send(id, [{ type: "ops", ops }])
    })
    ;(published as { dispose: () => void }).dispose = () => {
      unsubscribe()
      state.dispose()
    }
    this.#conversations.set(id, published)
    this.#send(id, [{ type: "snapshot", value: published.value }])
  }

  /** Send every stream's current value again, e.g. after the hub asked for fresh snapshots. */
  resnapshot(): void {
    this.#publishSession(true)
    for (const [id, published] of this.#conversations) this.#send(id, [{ type: "snapshot", value: published.value }])
  }

  notice(level: ViewNotice["level"], message: string): void {
    this.#update({ notices: [...this.#session.notices, { id: this.#nextNotice++, level, message }].slice(-20) })
  }

  fail = (error: unknown): void => this.notice("error", error instanceof Error ? error.message : String(error))

  /** Report a prompt that ends without an answer, as Pi does. */
  watchAnswer(submission: Submission): void {
    void submission.wait(this.#context).then((settled) => {
      if (settled.status === "unanswered" && settled.reason !== "aborted") {
        this.notice("error", `No answer: ${settled.reason}${settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`}`)
      }
    }, () => {})
  }

  /** Report a compaction's outcome once it is known, as Pi does. */
  watchCompaction(taskId: Parameters<Harness["waitForTask"]>[0]): void {
    void this.#harness.waitForTask(taskId, this.#context).then(async (receipt) => {
      const outcome = receipt.state.outcome
      if (outcome.status === "completed") {
        const { entryId, submissionId } = outcome.result as { entryId?: unknown; submissionId?: Parameters<Harness["submission"]>[0] }
        const status = submissionId === undefined
          ? undefined
          : (await (await this.#harness.submission(submissionId, this.#context))?.status(this.#context))?.status
        this.notice(
          "info",
          entryId !== undefined || status === "done"
            ? "Compacted."
            : status === "queued"
            ? "Compaction summary queued; it is placed at the next turn boundary."
            : status === "unanswered"
            ? "Compaction summary dropped: the context changed under it."
            : "Nothing to compact: the context fits in the recent window that is kept verbatim."
        )
      } else if (outcome.status === "aborted") this.notice("info", "Compaction aborted.")
      else this.notice("error", `Compaction ${outcome.status}: ${(outcome as { error?: { message?: string } }).error?.message ?? (outcome as { reason?: string }).reason ?? ""}`)
    }, this.fail)
  }

  /** The next thinking level of the conversation's model, as Pi's thinking key cycles. */
  nextThinkingLevel(view: ConversationView): ModelThinkingLevel {
    const model = this.#currentModel(view)
    if (!model.reasoning) throw new Error("Current model does not support thinking")
    const levels = getSupportedThinkingLevels(model)
    const level = agentOf(view).thinkingLevel ?? "off"
    return levels[(levels.indexOf(level) + 1) % levels.length] ?? "off"
  }

  /** The thinking level to keep when switching models, clamped to what the new model supports. */
  thinkingFor(view: ConversationView, ref: { provider: string; modelId: string }): ModelThinkingLevel {
    const model = this.#models.getModel(ref.provider, ref.modelId)
    if (model === undefined) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`)
    return clampThinkingLevel(model, agentOf(view).thinkingLevel ?? "off")
  }

  /** The current view of a conversation, once watched. */
  viewOf(id: number): ConversationView | undefined {
    return this.#conversations.get(id)?.value as unknown as ConversationView | undefined
  }

  #currentModel(view: ConversationView) {
    const ref = agentOf(view).model
    const model = ref === undefined ? undefined : this.#models.getModel(ref.provider, ref.modelId)
    if (model === undefined) throw new Error(ref === undefined ? "No model selected" : "Current model is unavailable")
    return model
  }

  #update(patch: Partial<SessionViewState>): void {
    this.#session = { ...this.#session, ...patch }
    this.#publishSession(false)
  }

  #publishSession(snapshot: boolean): void {
    if (this.#closed) return
    const value = JSON.parse(JSON.stringify(this.#session)) as JsonValue
    if (snapshot || this.#sessionSent === undefined) this.#send(SESSION_VIEW, [{ type: "snapshot", value }])
    else {
      const ops = diffRevisions(this.#sessionSent, value)
      if (ops.length === 0) return
      this.#send(SESSION_VIEW, [{ type: "ops", ops }])
    }
    this.#sessionSent = value
  }

  close(): void {
    this.#closed = true
    for (const dispose of this.#disposers) dispose()
    for (const published of this.#conversations.values()) published.dispose()
    this.#conversations.clear()
  }
}
