import { createHost, type Ctx, type Facet, type Frame, invalid, type ReplicatedState, replicatedState } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context"
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type ImageContent,
  type ModelThinkingLevel,
  type TextContent
} from "@earendil-works/pi-ai"
import type { Models as ModelRegistry } from "@earendil-works/pi-ai/models"
import {
  AgentDoc,
  type AgentState,
  type Conversation as PiConversation,
  type ConversationId,
  ConversationBusy,
  type ConversationView,
  type Cursor,
  type EntryRecord,
  type Harness,
  type LiveState,
  type ProviderState,
  type Submission,
  type SubmissionId,
  type TaskId,
  type UserInput
} from "@earendil-works/pi-durable"
import {
  type ConversationSummary,
  ConversationObject,
  FrameLink,
  type ModelCatalog,
  type ModelConfiguration,
  type Notice,
  type OperationResponse,
  type Principal,
  principalKey,
  type PromptRequest,
  SessionObject,
  sessionHost
} from "@pi-cloud/protocol"
import { Type } from "typebox"
import type { LiveStreams, Streamed } from "./LiveStreams.ts"
import { outbox } from "./Outbox.ts"

export interface SessionServices {
  frames(link: number, frames: ReadonlyArray<unknown>): void
  readonly attached: number
  notice(level: Notice["level"], message: string): void
  watchAnswer(submission: Submission): void
  watchCompaction(taskId: TaskId): void
  dispose(): Promise<void>
}

const titleOf = (entry: EntryRecord | undefined): string | null => {
  const message = entry?.model?.[0]
  if (message?.role !== "user") return null
  const content = typeof message.content === "string"
    ? message.content
    : message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(" ")
  return content.replace(/\s+/g, " ").trim()
}

const toInput = (request: PromptRequest): UserInput => {
  if (request.images === undefined || request.images.length === 0) return request.message
  const content: Array<TextContent | ImageContent> = [{ type: "text", text: request.message }, ...request.images]
  return content
}

const refused = (error: unknown): OperationResponse => ({
  accepted: false,
  error: error instanceof ConversationBusy
    ? { code: "busy", message: error.message }
    : { code: "operation_failed", message: error instanceof Error ? error.message : String(error) }
})

const parseSubmissionId = (value: string): SubmissionId | undefined => {
  const id = Number(value)
  return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(id) ? (id as SubmissionId) : undefined
}

const Anything = Type.Unsafe<any>(Type.Unknown())

export const openSessionServices = async (options: {
  readonly sessionId: string
  readonly harness: Harness
  readonly root: PiConversation
  readonly models: ModelRegistry
  readonly facets: ReadonlyArray<Facet<Principal>>
  readonly live: LiveStreams
  readonly transmit: (link: number, frames: ReadonlyArray<Frame>) => Promise<void>
  readonly context: Context
}): Promise<SessionServices> => {
  const { sessionId, harness, root, models, context } = options
  const durable = (ctx: Ctx<Principal>) => withAbortSignal(ctx.signal, context)

  const notices = replicatedState<{ list: Array<Notice> }>({ list: [] })
  let nextNotice = 1
  const notice = (level: Notice["level"], message: string) =>
    notices.change(BACKGROUND_CONTEXT, (draft) => {
      draft.list.push({ id: nextNotice++, level, message })
      if (draft.list.length > 20) draft.list.splice(0, draft.list.length - 20)
    })
  const watchAnswer = (submission: Submission) =>
    void submission.wait(context).then((settled) => {
      if (settled.status === "unanswered" && settled.reason !== "aborted") {
        notice("error", `No answer: ${settled.reason}${settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`}`)
      }
    }, () => {})
  const watchCompaction = (taskId: TaskId) =>
    void harness.waitForTask(taskId, context).then(async (receipt) => {
      const outcome = receipt.state.outcome
      if (outcome.status === "completed") {
        const { entryId, submissionId } = outcome.result as { entryId?: unknown; submissionId?: SubmissionId }
        const status = submissionId === undefined
          ? undefined
          : (await (await harness.submission(submissionId, context))?.status(context))?.status
        notice(
          "info",
          entryId !== undefined || status === "done"
            ? "Compacted."
            : status === "queued"
            ? "Compaction summary queued; it is placed at the next turn boundary."
            : status === "unanswered"
            ? "Compaction summary dropped: the context changed under it."
            : "Nothing to compact: the context fits in the recent window that is kept verbatim."
        )
      } else if (outcome.status === "aborted") notice("info", "Compaction aborted.")
      else notice("error", `Compaction ${outcome.status}: ${(outcome as { error?: { message?: string } }).error?.message ?? ""}`)
    }, (error) => notice("error", String(error)))

  let catalogRevision = 0
  const listModels = async (): Promise<ModelCatalog["availableModels"]> =>
    (await models.getAvailable().catch(() => [])).map((model) => ({
      provider: model.provider,
      modelId: model.id,
      name: model.name,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow
    }))
  const catalog = replicatedState<ModelCatalog>({
    revision: ++catalogRevision,
    availableModels: await listModels(),
    refresh: { status: "idle" }
  })

  const conversations = replicatedState<{ list: Array<ConversationSummary> }>({ list: [] })
  const listed = new Set<number>()
  const label = (id: number) => (id === root.id ? "main" : `subagent ${id}`)
  const list = (id: number, title: string | null) => {
    if (listed.has(id)) return
    listed.add(id)
    conversations.change(BACKGROUND_CONTEXT, (draft) => void draft.list.push({ id, label: label(id), title }))
  }
  let cursor: Cursor | undefined
  do {
    const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), context)
    for (const { id } of page.items) {
      let first: EntryRecord | undefined
      const conversation = id === root.id ? undefined : await harness.conversation(id, context)
      let entries: Cursor | undefined
      if (conversation !== undefined) {
        do {
          const entryPage = await conversation.entries({}, 256, entries, context)
          first = entryPage.items.findLast((entry) => entry.kind === "pi.user") ?? first
          entries = entryPage.next
        } while (entries !== undefined)
      }
      list(id, titleOf(first))
    }
    cursor = page.next
  } while (cursor !== undefined)
  const unsubscribeCommits = harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type === "conversation") list(change.value.id, null)
      else if (change.type === "entry" && change.value.kind === "pi.user" && change.value.conversationId !== root.id) {
        const id = change.value.conversationId
        const title = titleOf(change.value)
        conversations.change(BACKGROUND_CONTEXT, (draft) => {
          const entry = draft.list.find((item) => item.id === id)
          if (entry !== undefined && entry.title === null) entry.title = title
        })
      }
    }
  })
  const tasks = await harness.taskGraph(context)

  let attached = 0
  const presence = {
    version: 1,
    open: () => void attached++,
    close: () => void attached--
  }

  const host = createHost<Principal>({
    name: sessionHost(sessionId),
    self: { kind: "host" },
    principalKey,
    onError: (error) => notice("warning", error instanceof Error ? error.message : String(error))
  })

  const mirror = <T>(
    self: Parameters<Parameters<typeof host.serve>[1]>[2],
    name: string,
    source: () => ReplicatedState<T> & { readonly value: T },
    project: (value: T) => unknown = (value) => value
  ) => {
    const cell = self.state(name, Anything, { init: () => project(source().value) })
    self.on(name, source(), (value, ctx) => cell.replace(ctx, project(value as T)))
    return cell
  }

  const checkSession = (session: string) => {
    if (session !== sessionId) throw invalid("input", `This host serves session ${sessionId}, not ${session}`)
  }

  host.serve(SessionObject, ({ session }, _principal, self) => {
    checkSession(session)
    self.resource("presence", presence)
    return {
      variant: "default",
      conversations: mirror(self, "conversations", () => conversations, (value) => value.list),
      models: mirror(self, "models", () => catalog),
      tasks: mirror(self, "tasks", () => tasks),
      notices: mirror(self, "notices", () => notices, (value) => value.list),
      refreshModels: async (ctx) => {
        catalog.change(BACKGROUND_CONTEXT, (draft) => void (draft.refresh = { status: "refreshing" }))
        const result = await models.refresh({ signal: ctx.signal }).catch(() => undefined)
        const errors = Object.fromEntries([...(result?.errors ?? [])].map(([id, error]) => [id, error.message]))
        const availableModels = await listModels()
        catalog.change(BACKGROUND_CONTEXT, (draft) => {
          draft.revision = ++catalogRevision
          draft.availableModels = availableModels
          draft.refresh = Object.keys(errors).length === 0 ? { status: "done" } : { status: "warning", errors }
        })
      },
      abortTask: async ({ taskId }, ctx) => void (await harness.abortTask(taskId as TaskId, durable(ctx)))
    }
  })

  host.serve(ConversationObject, ({ session, conversation: id = root.id }, _principal, self) => {
    checkSession(session)
    self.resource("presence", presence)
    const conversation = self.resource("conversation", {
      version: 1,
      open: async () => {
        const found = id === root.id ? root : await harness.conversation(id as ConversationId, context)
        if (found === undefined) throw invalid("not_found", `Conversation ${id} not found`)
        return found
      }
    })
    const view = self.resource("view", {
      version: 1,
      deps: [conversation],
      open: () => conversation.value.viewState(context),
      close: (state) => state.dispose()
    })
    const agent = self.resource("agent", {
      version: 1,
      deps: [conversation],
      open: async () => {
        const state = await harness.documentState(AgentDoc, conversation.value.id, context)
        if (state === undefined) throw invalid("not_found", `Conversation ${id} has no agent document`)
        return state
      },
      close: (state) => state.dispose()
    })

    const selected = (state: Readonly<AgentState> | null | undefined) =>
      state?.model === undefined ? undefined : models.getModel(state.model.provider, state.model.modelId)
    const levels = (state: Readonly<AgentState> | null | undefined): Array<ModelThinkingLevel> => {
      const model = selected(state)
      return model === undefined ? ["off"] : getSupportedThinkingLevels(model)
    }
    const configurationOf = (state: Readonly<AgentState> | null | undefined): ModelConfiguration => ({
      model: state?.model === undefined ? null : { provider: state.model.provider, modelId: state.model.modelId },
      thinkingLevel: state?.thinkingLevel ?? "off",
      thinkingLevels: levels(state)
    })
    const summaryOf = (list: ReadonlyArray<ConversationSummary>): ConversationSummary =>
      list.find((item) => item.id === id) ?? { id, label: label(id), title: null }

    const summary = mirror(self, "summary", () => conversations, (value) => summaryOf(value.list))
    const streamOf = (value: ConversationView) => {
      const id = (value.docs["pi.provider"] as ProviderState | undefined)?.sessionId
      return id === undefined ? undefined : options.live.get(id)
    }
    let superseded: Streamed | undefined
    const shown = (value: ConversationView) => {
      const streamed = streamOf(value)
      const live = value.docs["pi.live"] as LiveState | undefined
      const generation = live?.generation
      if (generation === undefined || generation.retry !== undefined || generation.deferred !== undefined) superseded = streamed
      if (streamed?.message === undefined || streamed === superseded) return value
      const message = JSON.parse(JSON.stringify(streamed.message))
      return { ...value, docs: { ...value.docs, "pi.live": { ...live, generation: { ...generation, message } } } }
    }
    const viewCell = self.state("view", Anything, {
      init: () => {
        const streamed = streamOf(view.value.value)
        if (streamed?.ended === true) superseded = streamed
        return shown(view.value.value)
      }
    })
    self.on("view", view, (state) => state, (value, ctx) => viewCell.replace(ctx, shown(value)))
    self.on("live", options.live, (id, ctx) => {
      if (options.live.get(id) === streamOf(view.value.value)) viewCell.replace(ctx, shown(view.value.value))
    })
    const configuration = self.state("configuration", Anything, { init: () => configurationOf(agent.value.value) })
    self.on("configuration", agent, (state) => state, (value, ctx) => configuration.replace(ctx, configurationOf(value)))

    const queue = async (whenBusy: "steer" | "followUp" | "reject", request: PromptRequest, ctx: Ctx<Principal>): Promise<OperationResponse> => {
      try {
        const submission = await conversation.value.submit({ type: "input", content: toInput(request), whenBusy }, durable(ctx))
        watchAnswer(submission)
        return { accepted: true, operationId: String(submission.id) }
      } catch (error) {
        return refused(error)
      }
    }

    return {
      variant: "default",
      summary,
      view: viewCell,
      configuration,
      prompt: (request, ctx) => queue("reject", request, ctx),
      steer: (request, ctx) => queue("steer", request, ctx),
      followUp: (request, ctx) => queue("followUp", request, ctx),
      cancelQueued: async ({ operationId }, ctx) => {
        const submissionId = parseSubmissionId(operationId)
        if (submissionId === undefined) return "not_found"
        const result = await harness.abortSubmission(submissionId, durable(ctx), conversation.value.id)
        return result === "aborted" ? "cancelled" : result === "not_found" ? "not_found" : "already_consumed"
      },
      abort: async (ctx) => void (await conversation.value.abort(durable(ctx))),
      compact: async ({ instructions }, ctx) => {
        try {
          const taskId = await conversation.value.compact(instructions, durable(ctx))
          watchCompaction(taskId)
          return { accepted: true, operationId: String(taskId) }
        } catch (error) {
          return refused(error)
        }
      },
      waitForPrompt: async ({ operationId }, ctx) => {
        const submissionId = parseSubmissionId(operationId)
        const submission = submissionId === undefined ? undefined : await harness.submission(submissionId, durable(ctx))
        if (submission === undefined) throw invalid("args", `Unknown prompt: ${operationId}`)
        const settled = await submission.wait(durable(ctx))
        if (settled.status === "unanswered") return { status: "unanswered", reason: settled.reason }
        const answer = settled.type === "input" ? settled.answer : undefined
        const message = answer === undefined ? undefined : (await harness.commit((tx) => tx.entry(answer), durable(ctx)))?.model?.[0]
        const text = message?.role === "assistant"
          ? message.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("")
          : ""
        return { status: "done", text }
      },
      selectModel: async (ref, ctx) => {
        const model = models.getModel(ref.provider, ref.modelId)
        if (model === undefined) throw invalid("args", `Unknown model: ${ref.provider}/${ref.modelId}`)
        const thinkingLevel = clampThinkingLevel(model, agent.value.value?.thinkingLevel ?? "off")
        await conversation.value.configure({ model: { provider: model.provider, modelId: model.id }, thinkingLevel }, durable(ctx))
      },
      selectThinking: async ({ level }, ctx) => {
        const available = levels(agent.value.value)
        if (!available.includes(level)) throw invalid("args", `Thinking level ${level} is unavailable; choose one of: ${available.join(", ")}`)
        await conversation.value.configure({ thinkingLevel: level }, durable(ctx))
      },
      cycleThinking: async (ctx) => {
        const state = agent.value.value
        const model = selected(state)
        if (model === undefined) throw invalid("state", "No model selected")
        if (!model.reasoning) throw invalid("state", "Current model does not support thinking")
        const all = levels(state)
        const next = all[(all.indexOf(state?.thinkingLevel ?? "off") + 1) % all.length] ?? "off"
        await conversation.value.configure({ thinkingLevel: next }, durable(ctx))
      }
    }
  })

  for (const facet of options.facets) await host.install(facet)

  const saved = configurationOfRoot(await harness.documentState(AgentDoc, root.id, context))
  if (saved === undefined) notice("warning", "No model configured; select one with /model.")
  else if (models.getModel(saved.provider, saved.modelId) === undefined) notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`)

  let upstream: { readonly id: number; readonly link: FrameLink } | undefined
  const connect = (id: number) => {
    upstream?.link.end("replaced")
    const send = outbox<Frame>((frames) => options.transmit(id, frames))
    const link: FrameLink = new FrameLink((frames) => void send(frames).catch(() => link.end("lease lost")))
    upstream = { id, link }
    host.connect(link, { principal: { kind: "server" } })
    return link
  }

  return {
    frames(id, frames) {
      const link = upstream?.id === id ? upstream.link : connect(id)
      link.deliver(frames)
    },
    get attached() {
      return attached
    },
    notice,
    watchAnswer,
    watchCompaction,
    async dispose() {
      upstream?.link.close("session closed")
      await host.close()
      unsubscribeCommits()
      tasks.dispose()
    }
  }
}

const configurationOfRoot = (state: { readonly value: Readonly<AgentState> | null; dispose(): void } | undefined) => {
  const model = state?.value?.model
  state?.dispose()
  return model
}
