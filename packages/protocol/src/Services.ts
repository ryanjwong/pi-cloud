import { hostFamily, hostNamed, method, remote } from "@earendil-works/chord"
import type { ConversationView, TaskGraph } from "@earendil-works/pi-durable"
import { Schema } from "effect"
import { type Static, Type } from "typebox"

export const Scope = Schema.Literals(["read", "write", "admin"])
export type Scope = typeof Scope.Type

export type Client = { readonly kind: "client"; readonly id: string; readonly name: string; readonly scopes: ReadonlyArray<Scope> }

export type Principal =
  | Client
  | { readonly kind: "host" }
  | { readonly kind: "server" }
  | { readonly kind: "runner"; readonly session: string }

export const principalKey = (principal: Principal): string =>
  principal.kind === "runner" ? `runner:${principal.session}` : principal.kind === "client" ? `client:${principal.id}` : principal.kind

const RANK: Record<Scope, number> = { read: 0, write: 1, admin: 2 }

export const allows = (principal: Principal, scope: Scope): boolean =>
  principal.kind === "client" && principal.scopes.some((granted) => RANK[granted] >= RANK[scope])

export const SERVER_HOST = "server"
export const sessionHost = (sessionId: string) => `session:${sessionId}`
export const sessionOfHost = (host: string): string | undefined =>
  host.startsWith("session:") ? host.slice("session:".length) : undefined

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()])

export const ModelRefSchema = Type.Object({ provider: Type.String(), modelId: Type.String() })

const ThinkingLevel = Type.Unsafe<import("@earendil-works/pi-ai").ModelThinkingLevel>(Type.String())

export const CloudSessionSchema = Type.Object({
  id: Type.String(),
  title: Nullable(Type.String()),
  createdAt: Type.Number(),
  spec: Type.Unknown(),
  runner: Type.Object({
    state: Type.Union([Type.Literal("idle"), Type.Literal("starting"), Type.Literal("running")]),
    runnerId: Nullable(Type.String())
  })
})
export type CloudSession = Static<typeof CloudSessionSchema>

export const ConversationSummarySchema = Type.Object({
  id: Type.Number(),
  label: Type.String(),
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

export const OperationResponseSchema = Type.Union([
  Type.Object({ accepted: Type.Literal(true), operationId: Type.String() }),
  Type.Object({ accepted: Type.Literal(false), error: OperationError })
])
export type OperationResponse = Static<typeof OperationResponseSchema>

export const PromptResultSchema = Type.Union([
  Type.Object({ status: Type.Literal("done"), text: Type.String() }),
  Type.Object({ status: Type.Literal("unanswered"), reason: Type.String() })
])
export type PromptResult = Static<typeof PromptResultSchema>

const ConversationViewSchema = Type.Unsafe<ConversationView>(Type.Unknown())
const TaskGraphSchema = Type.Unsafe<TaskGraph>(Type.Unknown())

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

export const SessionObject = remote("pi-cloud.session", {
  version: 1,
  input: Type.Object({ session: Type.String() }),
  host: hostFamily("session:", "session"),
  variants: {
    default: {
      state: {
        conversations: Type.Array(ConversationSummarySchema),
        models: ModelCatalogSchema,
        tasks: TaskGraphSchema,
        notices: Type.Array(NoticeSchema)
      },
      methods: {
        refreshModels: method(),
        abortTask: method(Type.Object({ taskId: Type.Number() }))
      }
    }
  }
})

export const ConversationObject = remote("pi-cloud.conversation", {
  version: 1,
  input: Type.Object({ session: Type.String(), conversation: Type.Optional(Type.Number({ default: 1 })) }),
  host: hostFamily("session:", "session"),
  variants: {
    default: {
      state: {
        summary: ConversationSummarySchema,
        view: ConversationViewSchema,
        configuration: ModelConfigurationSchema
      },
      methods: {
        prompt: method(PromptRequestSchema, OperationResponseSchema),
        steer: method(PromptRequestSchema, OperationResponseSchema),
        followUp: method(PromptRequestSchema, OperationResponseSchema),
        cancelQueued: method(
          Type.Object({ operationId: Type.String() }),
          Type.Union([Type.Literal("cancelled"), Type.Literal("already_consumed"), Type.Literal("not_found")])
        ),
        abort: method(),
        compact: method(Type.Object({ instructions: Type.Optional(Type.String()) }), OperationResponseSchema),
        waitForPrompt: method(Type.Object({ operationId: Type.String() }), PromptResultSchema),
        selectModel: method(ModelRefSchema),
        selectThinking: method(Type.Object({ level: ThinkingLevel })),
        cycleThinking: method()
      }
    }
  }
})
