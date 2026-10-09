import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity, OpenApi } from "effect/http-api"
import { SessionCommand, Submitted } from "./Commands.ts"
import { EventBatch, SessionId, SessionSpec, SessionView, UserContent, WhenBusy } from "./Domain.ts"
import { CommandFailed, ConversationBusy, RunnerUnavailable, SessionNotFound, Unauthorized } from "./Errors.ts"

/**
 * Bearer authentication for the public API. The control plane chooses the implementation (a static key, an
 * identity provider, ...); clients supply their token through the client-side layer.
 */
export class ApiAuth extends HttpApiMiddleware.Service<ApiAuth>()("@pi-cloud/protocol/ApiAuth", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}

const sessionParams = { id: SessionId }

export const CreateSession = Schema.Struct({
  title: Schema.optional(Schema.String),
  spec: Schema.optional(SessionSpec)
})

export const SubmitMessage = Schema.Struct({
  content: UserContent,
  /** Makes the submission exactly-once: a retry with the same id returns the original submission. */
  requestId: Schema.optional(Schema.String),
  whenBusy: Schema.optional(WhenBusy),
  /** Defaults to the session's root conversation. */
  conversationId: Schema.optional(Schema.Number)
})

export const EntriesPage = Schema.Struct({
  /** Pi `EntryRecord`s, oldest first. */
  entries: Schema.Array(Schema.Json),
  /** Pass back as `cursor` to read the next page. */
  next: Schema.optional(Schema.String)
})

export class SessionsApi extends HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.post("create", "/", { payload: CreateSession, success: SessionView }),
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(SessionView) }),
    HttpApiEndpoint.get("get", "/:id", { params: sessionParams, success: SessionView, error: SessionNotFound }),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: sessionParams,
      success: HttpApiSchema.NoContent,
      error: SessionNotFound
    }),
    HttpApiEndpoint.post("submit", "/:id/messages", {
      params: sessionParams,
      payload: SubmitMessage,
      success: Submitted,
      error: [SessionNotFound, RunnerUnavailable, ConversationBusy, CommandFailed]
    }),
    /**
     * Run any session command (prompt, abort, configure, compact, reset, or a plugin's custom command). The
     * WebSocket channel at `/v1/sessions/{id}/channel` accepts the same commands.
     */
    HttpApiEndpoint.post("command", "/:id/commands", {
      params: sessionParams,
      payload: SessionCommand,
      success: Schema.Struct({ value: Schema.optional(Schema.Json) }),
      error: [SessionNotFound, RunnerUnavailable, ConversationBusy, CommandFailed]
    }),
    HttpApiEndpoint.post("abort", "/:id/abort", {
      params: sessionParams,
      payload: Schema.Struct({ conversationId: Schema.optional(Schema.Number) }),
      success: HttpApiSchema.NoContent,
      error: [SessionNotFound, RunnerUnavailable, CommandFailed]
    }),
    /**
     * Live Pi agent events as server-sent events. A stream starts with the newest snapshot batch the control plane
     * holds, then every batch after it. Reconnect with `after=<epoch>:<seq>` of the last batch seen to resume
     * without a fresh snapshot when the gap is still buffered.
     */
    HttpApiEndpoint.get("events", "/:id/events", {
      params: sessionParams,
      query: { after: Schema.optional(Schema.String) },
      success: HttpApiSchema.StreamSse({ data: EventBatch }),
      error: SessionNotFound
    }),
    // Reads below go straight to the state store: they work whether or not a runner is attached.
    HttpApiEndpoint.get("entries", "/:id/entries", {
      params: sessionParams,
      query: {
        conversationId: Schema.optional(Schema.FiniteFromString),
        limit: Schema.optional(Schema.FiniteFromString),
        cursor: Schema.optional(Schema.String)
      },
      success: EntriesPage,
      error: SessionNotFound
    }),
    HttpApiEndpoint.get("conversations", "/:id/conversations", {
      params: sessionParams,
      success: Schema.Array(Schema.Json),
      error: SessionNotFound
    }),
    HttpApiEndpoint.get("submission", "/:id/submissions/:submissionId", {
      params: { id: SessionId, submissionId: Schema.FiniteFromString },
      success: Schema.Json,
      error: SessionNotFound
    })
  )
  .middleware(ApiAuth)
  .prefix("/v1/sessions")
  .annotateMerge(OpenApi.annotations({
    title: "Sessions",
    description: "Create sessions, talk to their agent, and read their durable state. " +
      "Live events stream from GET /v1/sessions/{id}/events."
  }))
{}

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent })
) {}

export class PublicApi extends HttpApi.make("pi-cloud")
  .add(SessionsApi)
  .add(SystemApi)
  .annotateMerge(OpenApi.annotations({ title: "pi-cloud control plane" }))
{}
