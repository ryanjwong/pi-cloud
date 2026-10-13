import {
  type Context,
  createFacetHost,
  createRemoteServiceEndpoint,
  defineFacet,
  type Facet,
  type FacetHost,
  type JsonValue,
  parseServiceCall,
  type RemoteServiceEndpoint,
  RemoteServiceError,
  replicatedState,
  type ServiceProviderUpdate
} from "@earendil-works/chord"
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context"
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
  type Cursor,
  type EntryRecord,
  type Harness,
  type Submission,
  type SubmissionId,
  type TaskId,
  type UserInput
} from "@earendil-works/pi-durable"
import {
  type AgentController as AgentControllerService,
  type AgentOperationError,
  type AgentPromptRequest,
  type AgentPromptResult,
  type AgentQueueResponse,
  AgentController,
  type Conversation as ConversationService,
  Conversations,
  type ConversationSummary,
  type ModelRef,
  Models,
  type Models as ModelsService,
  type ModelsState,
  type Notice,
  Notices,
  type NoticesState,
  Tasks,
  Transcript
} from "@pi-cloud/protocol"

/**
 * A session's Chord services (see `Services.ts` in `@pi-cloud/protocol`), served by the runner that hosts it.
 * Presentations reach them through the control plane, which relays each attachment's calls here.
 */
export interface SessionServices {
  /** Run one call of an attachment; subscription updates go to `publish`. */
  invoke(
    attachmentId: string,
    callId: string,
    call: unknown,
    publish: (subscriptionId: string, update: ServiceProviderUpdate) => void
  ): Promise<JsonValue | undefined>
  cancel(callId: string): void
  release(attachmentId: string): void
  /** Presentations attached right now; the runner stays while there are any. */
  readonly attachments: number
  notice(level: Notice["level"], message: string): void
  /** Report a prompt that ends without an answer, as Pi does. */
  watchAnswer(submission: Submission): void
  /** Report a compaction's outcome once known, as Pi does. */
  watchCompaction(taskId: TaskId): void
  dispose(): Promise<void>
}

const text = (entry: EntryRecord | undefined): string | null => {
  const message = entry?.model?.[0]
  if (message?.role !== "user") return null
  const content = typeof message.content === "string"
    ? message.content
    : message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(" ")
  return content.replace(/\s+/g, " ").trim()
}

const toInput = (request: AgentPromptRequest): UserInput => {
  if (request.images === null || request.images.length === 0) return request.message
  const content: Array<TextContent | ImageContent> = [{ type: "text", text: request.message }, ...request.images]
  return content
}

const toAgentError = (error: unknown): AgentOperationError =>
  error instanceof ConversationBusy
    ? { code: "busy", message: error.message }
    : { code: "operation_failed", message: error instanceof Error ? error.message : String(error) }

const parseSubmissionId = (value: string): SubmissionId | undefined => {
  const id = Number(value)
  return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(id) ? (id as SubmissionId) : undefined
}

/**
 * Open the session's services: Pi's `Transcript`, `AgentController` and `Models` for the root conversation, and
 * pi-cloud's keyed `Conversation`s, `Tasks` and `Notices`, plus whatever services `facets` provide. Ported from
 * Pi's session worker (github.com/earendil-works/pi, v1.1.0, packages/coding-agent/src/experimental/services;
 * MIT License, Copyright (c) 2025 Mario Zechner).
 */
export const openSessionServices = async (options: {
  readonly harness: Harness
  readonly root: PiConversation
  readonly models: ModelRegistry
  readonly facets: ReadonlyArray<Facet>
  readonly context: Context
}): Promise<SessionServices> => {
  const { harness, root, models, context } = options

  // Notices: what went wrong without an error to return.
  const notices = replicatedState<NoticesState>({ notices: [] })
  let nextNotice = 1
  const notice = (level: Notice["level"], message: string) =>
    notices.change(BACKGROUND_CONTEXT, (draft) => {
      draft.notices.push({ id: nextNotice++, level, message })
      if (draft.notices.length > 20) draft.notices.splice(0, draft.notices.length - 20)
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

  /** Pi's agent controller over one conversation, reporting unanswered prompts and compaction outcomes. */
  const controller = (conversation: PiConversation): AgentControllerService => {
    const queue = async (whenBusy: "steer" | "followUp", request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse> => {
      try {
        const submission = await conversation.submit({ type: "input", content: toInput(request), whenBusy }, context)
        watchAnswer(submission)
        return { accepted: true, entryId: String(submission.id), error: null }
      } catch (error) {
        return { accepted: false, entryId: null, error: toAgentError(error) }
      }
    }
    return {
      async prompt(request, context) {
        try {
          const submission = await conversation.submit({ type: "input", content: toInput(request), whenBusy: "reject" }, context)
          watchAnswer(submission)
          return { accepted: true, operationId: String(submission.id), error: null }
        } catch (error) {
          return { accepted: false, operationId: null, error: toAgentError(error) }
        }
      },
      steer: (request, context) => queue("steer", request, context),
      followUp: (request, context) => queue("followUp", request, context),
      async cancelQueued(entryId, context) {
        const id = parseSubmissionId(entryId)
        if (id === undefined) return { outcome: "not_found" }
        const result = await harness.abortSubmission(id, context, conversation.id)
        return { outcome: result === "aborted" ? "cancelled" : result === "not_found" ? "not_found" : "already_consumed" }
      },
      abort: (context) => conversation.abort(context),
      async compact(request, context) {
        try {
          const id = await conversation.compact(request.customInstructions ?? undefined, context)
          watchCompaction(id)
          return { accepted: true, operationId: String(id), error: null }
        } catch (error) {
          return { accepted: false, operationId: null, error: toAgentError(error) }
        }
      },
      async waitForPrompt(operationId, context): Promise<AgentPromptResult> {
        const id = parseSubmissionId(operationId)
        const submission = id === undefined ? undefined : await harness.submission(id, context)
        if (submission === undefined) throw new RemoteServiceError("service_invalid_value", `Unknown prompt: ${operationId}`)
        const settled = await submission.wait(context)
        if (settled.status === "unanswered") return { status: "unanswered", text: null, reason: settled.reason }
        const answer = settled.type === "input" ? settled.answer : undefined
        const message = answer === undefined ? undefined : (await harness.commit((tx) => tx.entry(answer), context))?.model?.[0]
        const text = message?.role === "assistant"
          ? message.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("")
          : ""
        return { status: "done", text, reason: null }
      }
    }
  }

  /** Model selection for one conversation, from its replicated agent document. */
  const modelControls = async (conversation: PiConversation) => {
    const agent = await harness.documentState(AgentDoc, conversation.id, context)
    if (agent === undefined) throw new Error(`Conversation ${conversation.id} has no agent document`)
    const current = (): Readonly<AgentState> | null => agent.value ?? null
    const selected = () => {
      const ref = current()?.model
      return ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId)
    }
    const levels = (): Array<ModelThinkingLevel> => {
      const model = selected()
      return model === undefined ? ["off"] : getSupportedThinkingLevels(model)
    }
    return {
      agent,
      levels,
      cycleThinking: async (context: Context) => {
        const model = selected()
        if (model === undefined) return notice("error", "No model selected")
        if (!model.reasoning) return notice("error", "Current model does not support thinking")
        const all = levels()
        const next = all[(all.indexOf(current()?.thinkingLevel ?? "off") + 1) % all.length] ?? "off"
        await conversation.configure({ thinkingLevel: next }, context)
      },
      select: async (ref: ModelRef, context: Context) => {
        const model = models.getModel(ref.provider, ref.modelId)
        if (model === undefined) return notice("error", `Unknown model: ${ref.provider}/${ref.modelId}`)
        const thinkingLevel = clampThinkingLevel(model, current()?.thinkingLevel ?? "off")
        await conversation.configure({ model: { provider: model.provider, modelId: model.id }, thinkingLevel }, context)
      },
      selectThinking: async (level: ModelThinkingLevel, context: Context) => {
        if (!levels().includes(level)) return notice("error", `Thinking level ${level} is unavailable; choose one of: ${levels().join(", ")}`)
        await conversation.configure({ thinkingLevel: level }, context)
      }
    }
  }

  const catalog = async (revision: number): Promise<ModelsState["catalog"]> => ({
    revision,
    availableModels: (await models.getAvailable().catch(() => [])).map((model) => ({
      provider: model.provider,
      modelId: model.id,
      name: model.name,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow
    }))
  })

  // Pi's root services.
  const transcript = await root.viewState(context)
  const rootModels = await modelControls(root)
  let catalogRevision = 1
  const configurationOf = (value: Readonly<AgentState> | null | undefined): ModelsState["configuration"] => ({
    model: value?.model === undefined ? null : { provider: value.model.provider, modelId: value.model.modelId },
    thinkingLevel: value?.thinkingLevel ?? "off"
  })
  const modelsState = replicatedState<ModelsState>({
    catalog: await catalog(catalogRevision),
    configuration: configurationOf(rootModels.agent.value),
    refresh: { status: "idle" }
  })
  const modelsService: ModelsService = {
    state: modelsState,
    cycleThinking: rootModels.cycleThinking,
    getThinkingLevels: async () => rootModels.levels(),
    async refresh(context) {
      modelsState.change(context, (draft) => void (draft.refresh = { status: "refreshing" }))
      const result = await models.refresh({ signal: context.abortSignal }).catch(() => undefined)
      const errors = Object.fromEntries([...(result?.errors ?? [])].map(([id, error]) => [id, error.message]))
      const next = await catalog(++catalogRevision)
      modelsState.change(context, (draft) => {
        draft.catalog = next
        draft.refresh = Object.keys(errors).length === 0 ? { status: "done" } : { status: "warning", errors }
      })
    },
    select: rootModels.select,
    selectThinking: rootModels.selectThinking
  }

  const tasks = await harness.taskGraph(context)
  const disposers: Array<() => void> = [
    () => transcript.dispose(),
    () => rootModels.agent.dispose(),
    () => tasks.dispose(),
    rootModels.agent.subscribe((value, context) => {
      const next = configurationOf(value)
      const now = modelsState.value.configuration
      if (now.model?.provider === next.model?.provider && now.model?.modelId === next.model?.modelId && now.thinkingLevel === next.thinkingLevel) return
      modelsState.change(context, (draft) => void (draft.configuration = next))
    })
  ]

  // Every conversation, as an instance of the keyed `Conversation` service.
  const conversationsFacet = defineFacet({
    id: "@pi-cloud/conversations",
    setup(env) {
      const spawner = env.provideMany(Conversations)
      const spawned = new Map<number, { summary: ReturnType<typeof replicatedState<ConversationSummary>> }>()
      const label = (id: number) => (id === root.id ? "main" : `subagent ${id}`)
      const spawn = async (id: number, title: string | null) => {
        if (spawned.has(id)) return
        const conversation = id === root.id ? root : await harness.conversation(id as ConversationId, context)
        if (conversation === undefined || spawned.has(id)) return
        const summary = replicatedState<ConversationSummary>({ id, label: label(id), title })
        spawned.set(id, { summary })
        const state = id === root.id ? transcript : await conversation.viewState(context)
        const controls = id === root.id ? rootModels : await modelControls(conversation)
        const service: ConversationService = {
          ...controller(conversation),
          summary,
          state,
          cycleThinking: controls.cycleThinking,
          selectModel: controls.select
        }
        const withdraw = spawner.spawn(String(id), service)
        env.own(() => {
          withdraw()
          if (id !== root.id) {
            state.dispose()
            controls.agent.dispose()
          }
        })
      }
      env.onActivate(async () => {
        let cursor: Cursor | undefined
        do {
          const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), context)
          for (const { id } of page.items) {
            const conversation = await harness.conversation(id, context)
            let first: EntryRecord | undefined
            if (conversation !== undefined && id !== root.id) {
              let entries: Cursor | undefined
              do {
                const entryPage = await conversation.entries({}, 256, entries, context)
                first = entryPage.items.findLast((entry) => entry.kind === "pi.user") ?? first
                entries = entryPage.next
              } while (entries !== undefined)
            }
            await spawn(id, text(first))
          }
          cursor = page.next
        } while (cursor !== undefined)
        // Subagents appear as their conversations are created; their titles with their first input.
        env.own(harness.subscribeCommits((publication) => {
          for (const change of publication.changes) {
            if (change.type === "conversation") void spawn(change.value.id, null).catch((error) => notice("warning", String(error)))
            else if (change.type === "entry" && change.value.kind === "pi.user") {
              const entry = spawned.get(change.value.conversationId)
              if (entry !== undefined && entry.summary.value.title === null && change.value.conversationId !== root.id) {
                entry.summary.change(BACKGROUND_CONTEXT, (draft) => void (draft.title = text(change.value)))
              }
            }
          }
        }))
      })
    }
  })

  const builtIns = defineFacet({
    id: "@pi-cloud/session",
    setup(env) {
      env.provide(Transcript, { state: transcript })
      env.provide(AgentController, controller(root))
      env.provide(Models, modelsService)
      env.provide(Tasks, {
        state: tasks,
        abort: async (taskId, context) => void (await harness.abortTask(taskId as TaskId, context))
      })
      env.provide(Notices, { state: notices })
    }
  })

  const host: FacetHost = await createFacetHost({
    facets: [builtIns, conversationsFacet, ...options.facets],
    onError: (error) => notice("warning", error.message)
  })

  const endpoints = new Map<string, RemoteServiceEndpoint>()
  const calls = new Map<string, () => void>()

  const saved = configurationOf(rootModels.agent.value).model
  if (saved === null) notice("warning", "No model configured; select one with /model.")
  else if (models.getModel(saved.provider, saved.modelId) === undefined) notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`)

  return {
    async invoke(attachmentId, callId, call, publish) {
      let endpoint = endpoints.get(attachmentId)
      if (endpoint === undefined) {
        endpoint = createRemoteServiceEndpoint(host.services)
        endpoints.set(attachmentId, endpoint)
      }
      const { context: callContext, cancel } = withCancel(context)
      calls.set(callId, cancel)
      try {
        return await endpoint.invoke(parseServiceCall(call), (subscriptionId, update) => publish(subscriptionId, update), callContext)
      } finally {
        calls.delete(callId)
      }
    },
    cancel: (callId) => calls.get(callId)?.(),
    release(attachmentId) {
      endpoints.get(attachmentId)?.dispose()
      endpoints.delete(attachmentId)
    },
    get attachments() {
      return endpoints.size
    },
    notice,
    watchAnswer,
    watchCompaction,
    async dispose() {
      for (const endpoint of endpoints.values()) endpoint.dispose()
      endpoints.clear()
      await host.dispose()
      for (const dispose of disposers) dispose()
    }
  }
}
