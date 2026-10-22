import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, HttpApiSecurity, OpenApi } from "effect/http-api"
import { SessionCommand, Submitted } from "./Commands.ts"
import { EventBatch, SessionId, SessionSpec, SessionView, UserContent, WhenBusy } from "./Domain.ts"
import { CredentialInfo, StoredCredential } from "./Credentials.ts"
import manifest from "../package.json" with { type: "json" }
import { CommandFailed, ConversationBusy, RunnerUnavailable, SessionNotFound, SpecRejected, Unauthorized } from "./Errors.ts"

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
  requestId: Schema.optional(Schema.String),
  whenBusy: Schema.optional(WhenBusy),
  conversationId: Schema.optional(Schema.Number)
})

export const EntriesPage = Schema.Struct({
  entries: Schema.Array(Schema.Json),
  next: Schema.optional(Schema.String)
})

export class SessionsApi extends HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.post("create", "/", { payload: CreateSession, success: SessionView, error: SpecRejected }),
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
    HttpApiEndpoint.get("events", "/:id/events", {
      params: sessionParams,
      query: { after: Schema.optional(Schema.String) },
      success: HttpApiSchema.StreamSse({ data: EventBatch }),
      error: SessionNotFound
    }),
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

export const VERSION = manifest.version

export const ServerInfo = Schema.Struct({
  version: Schema.String,
  servicesPath: Schema.String
})

export const ServerDetails = Schema.Struct({
  ...ServerInfo.fields,
  defaultModel: Schema.optional(Schema.String),
  defaultSandbox: Schema.String,
  sandboxTemplates: Schema.Array(Schema.String)
})

export class ServerApi extends HttpApiGroup.make("server", { topLevel: true })
  .add(HttpApiEndpoint.get("serverDetails", "/v1/server/details", { success: ServerDetails }))
  .middleware(ApiAuth)
{}

export class CredentialsApi extends HttpApiGroup.make("credentials")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(CredentialInfo) }),
    HttpApiEndpoint.put("put", "/:providerId", {
      params: { providerId: Schema.String },
      payload: StoredCredential,
      success: CredentialInfo
    }),
    HttpApiEndpoint.delete("delete", "/:providerId", {
      params: { providerId: Schema.String },
      success: HttpApiSchema.NoContent
    })
  )
  .middleware(ApiAuth)
  .prefix("/v1/credentials")
  .annotateMerge(OpenApi.annotations({
    title: "Credentials",
    description: "Model provider credentials, stored encrypted by the control plane and used by runners."
  }))
{}

export class SystemApi extends HttpApiGroup.make("system", { topLevel: true }).add(
  HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent }),
  HttpApiEndpoint.get("server", "/v1/server", { success: ServerInfo })
) {}

export class PublicApi extends HttpApi.make("pi-cloud")
  .add(SessionsApi)
  .add(CredentialsApi)
  .add(ServerApi)
  .add(SystemApi)
  .annotateMerge(OpenApi.annotations({ title: "pi-cloud control plane" }))
{}
