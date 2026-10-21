/**
 * The service API: Chord objects (`@earendil-works/chord`), reached over the WebSocket at `/v1/pi` with
 * `connectServices` from `@pi-cloud/client`. This is what presentations are built on: a TUI, a web UI, a dashboard.
 *
 * The control plane is the Chord host `server`. It serves the session directory itself and relays everything else to
 * the host `session:<id>`, which is the runner hosting that session, woken on demand. A client never names a host:
 * each contract says where its objects live.
 *
 * - `pi-cloud.sessions` (on `server`): every session with its spec and runner, and creating or removing one.
 * - `pi-cloud.session` (on `session:<id>`): the session's conversations, models, live task graph, and notices.
 * - `pi-cloud.conversation` (on `session:<id>`): one conversation, the root (`1`) or a subagent's: Pi Durable's
 *   view of it, its model configuration, and its controls.
 *
 * State is replicated: a reference gets a snapshot, then deltas. Plugins on the runner can serve more types on the
 * session's host.
 */
import { hostFamily, hostNamed, method, remote } from "@earendil-works/chord"
import type { ConversationView, TaskGraph } from "@earendil-works/pi-durable"
import { type Static, Type } from "typebox"

/** Who a request acts as. Single tenant: every authenticated client may do everything. */
export type Principal =
  | { readonly kind: "client" }
  | { readonly kind: "host" }
  | { readonly kind: "server" }
  | { readonly kind: "runner"; readonly session: string }

export const principalKey = (principal: Principal): string =>
  principal.kind === "runner" ? `runner:${principal.session}` : principal.kind

/** The control plane's host name. */
export const SERVER_HOST = "server"
/** The host of a session: the runner hosting it. */
export const sessionHost = (sessionId: string) => `session:${sessionId}`
/** The session a session host serves, or undefined for another host name. */
export const sessionOfHost = (host: string): string | undefined =>
  host.startsWith("session:") ? host.slice("session:".length) : undefined

// ---------------------------------------------------------------------------------------------------------------
// Schemas

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()])

export const ModelRefSchema = Type.Object({ provider: Type.String(), modelId: Type.String() })

const ThinkingLevel = Type.Unsafe<import("@earendil-works/pi-ai").ModelThinkingLevel>(Type.String())

/** A session as pi-cloud knows it: its spec (model, sandbox, metadata) and where it runs. */
export const CloudSessionSchema = Type.Object({
  id: Type.String(),
  title: Nullable(Type.String()),
  createdAt: Type.Number(),
  /** The `SessionSpec`, as JSON. */
  spec: Type.Unknown(),
  runner: Type.Object({
    state: Type.Union([Type.Literal("idle"), Type.Literal("starting"), Type.Literal("running")]),
    runnerId: Nullable(Type.String())
  })
})
export type CloudSession = Static<typeof CloudSessionSchema>

export const ConversationSummarySchema = Type.Object({
  id: Type.Number(),
  /** `main` for the root conversation, `subagent N` for a subagent's. */
  label: Type.String(),
  /** The conversation's first user message; for a subagent, its task. */
  title: Nullable(Type.String())
})
export type ConversationSummary = Static<typeof ConversationSummarySchema>

export const ModelSummarySchema = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  name: Type.String(),
  reasoning: Type.Boolean(),
  contextWindow: Type.Optional(Type.Number())
})
export type ModelSummary = Static<typeof ModelSummarySchema>

export const ModelCatalogSchema = Type.Object({
  revision: Type.Number(),
  availableModels: Type.Array(ModelSummarySchema),
  refresh: Type.Union([
    Type.Object({ status: Type.Union([Type.Literal("idle"), Type.Literal("refreshing"), Type.Literal("done")]) }),
    Type.Object({ status: Type.Literal("warning"), errors: Type.Record(Type.String(), Type.String()) })
  ])
})
export type ModelCatalog = Static<typeof ModelCatalogSchema>

/** A conversation's model and thinking level, and the levels its model supports. */
export const ModelConfigurationSchema = Type.Object({
  model: Nullable(ModelRefSchema),
  thinkingLevel: ThinkingLevel,
  thinkingLevels: Type.Array(ThinkingLevel)
})
export type ModelConfiguration = Static<typeof ModelConfigurationSchema>

export const NoticeSchema = Type.Object({
  id: Type.Number(),
  level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
  message: Type.String()
})
export type Notice = Static<typeof NoticeSchema>

const PromptImage = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() })

export const PromptRequestSchema = Type.Object({
  message: Type.String(),
  images: Type.Optional(Type.Array(PromptImage))
})
export type PromptRequest = Static<typeof PromptRequestSchema>

const OperationError = Type.Object({ code: Type.String(), message: Type.String() })

/** `operationId` identifies the durable submission of a prompt, or the task of a compaction. */
export const OperationResponseSchema = Type.Union([
  Type.Object({ accepted: Type.Literal(true), operationId: Type.String() }),
  Type.Object({ accepted: Type.Literal(false), error: OperationError })
])
export type OperationResponse = Static<typeof OperationResponseSchema>

/** The settled outcome of a prompt: the answer's text, or why it got none. */
export const PromptResultSchema = Type.Union([
  Type.Object({ status: Type.Literal("done"), text: Type.String() }),
  Type.Object({ status: Type.Literal("unanswered"), reason: Type.String() })
])
export type PromptResult = Static<typeof PromptResultSchema>

/** Pi Durable's own types, replicated as they are; Pi defines and versions them. */
const ConversationViewSchema = Type.Unsafe<ConversationView>(Type.Unknown())
const TaskGraphSchema = Type.Unsafe<TaskGraph>(Type.Unknown())

// ---------------------------------------------------------------------------------------------------------------
// Contracts

/** pi-cloud's sessions, live; creating one with a spec, and removing one. */
export const SessionsObject = remote("pi-cloud.sessions", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed(SERVER_HOST),
  variants: {
    default: {
      state: { sessions: Type.Array(CloudSessionSchema) },
      methods: {
        create: method(Type.Object({ title: Type.Optional(Type.String()), spec: Type.Optional(Type.Unknown()) }), CloudSessionSchema),
        remove: method(Type.Object({ id: Type.String() }))
      }
    }
  }
})

/** One session, served by its runner: its conversations, the models it can use, its tasks, and its notices. */
export const SessionObject = remote("pi-cloud.session", {
  version: 1,
  input: Type.Object({ session: Type.String() }),
  host: hostFamily("session:", "session"),
  variants: {
    default: {
      state: {
        conversations: Type.Array(ConversationSummarySchema),
        models: ModelCatalogSchema,
        /** Pi Durable's live task graph: every live task, what it waits on, and the conversations it owns. */
        tasks: TaskGraphSchema,
        /** What went wrong without an error to return: a prompt that ended unanswered, a compaction's outcome. */
        notices: Type.Array(NoticeSchema)
      },
      methods: {
        refreshModels: method(),
        /** Abort one task and what it owns. */
        abortTask: method(Type.Object({ taskId: Type.Number() }))
      }
    }
  }
})

/** One conversation of a session: the root (`1`) or a subagent's. */
export const ConversationObject = remote("pi-cloud.conversation", {
  version: 1,
  input: Type.Object({ session: Type.String(), conversation: Type.Optional(Type.Number({ default: 1 })) }),
  host: hostFamily("session:", "session"),
  variants: {
    default: {
      state: {
        summary: ConversationSummarySchema,
        /** Pi Durable's view: active entries and the live, inbox, agent, and usage documents. */
        view: ConversationViewSchema,
        configuration: ModelConfigurationSchema
      },
      methods: {
        /** Start a run; refused with `busy` while one is active. */
        prompt: method(PromptRequestSchema, OperationResponseSchema),
        /** Steer the active run, or start one when idle. */
        steer: method(PromptRequestSchema, OperationResponseSchema),
        /** Queue input for after the active run, or start one when idle. */
        followUp: method(PromptRequestSchema, OperationResponseSchema),
        /** Withdraw queued input while it is still queued. */
        cancelQueued: method(
          Type.Object({ operationId: Type.String() }),
          Type.Union([Type.Literal("cancelled"), Type.Literal("already_consumed"), Type.Literal("not_found")])
        ),
        /** Withdraw queued input and abort the active run and compaction. */
        abort: method(),
        compact: method(Type.Object({ instructions: Type.Optional(Type.String()) }), OperationResponseSchema),
        /** Wait until the prompt with this `operationId` is answered or settles unanswered. */
        waitForPrompt: method(Type.Object({ operationId: Type.String() }), PromptResultSchema),
        /** Switch model, keeping the thinking level, clamped to what the new model supports. */
        selectModel: method(ModelRefSchema),
        selectThinking: method(Type.Object({ level: ThinkingLevel })),
        /** Cycle the thinking level through those the model supports. */
        cycleThinking: method()
      }
    }
  }
})
