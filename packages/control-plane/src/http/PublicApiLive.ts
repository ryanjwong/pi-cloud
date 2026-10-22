import { ControlPlaneConfig, CredentialStore, parsePosition, type VersionedCredential } from "@pi-cloud/core"
import { CommandFailed, type CredentialInfo, PublicApi, type SessionId, type Submitted, VERSION } from "@pi-cloud/protocol"
import { Effect, Layer, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { SERVICES_PATH } from "../services/ServiceHost.ts"
import { Sessions } from "../Sessions.ts"

export const SessionsApiLive = HttpApiBuilder.group(
  PublicApi,
  "sessions",
  Effect.fn(function*(handlers) {
    const sessions = yield* Sessions
    return handlers
      .handle("create", ({ payload }) => sessions.create(payload))
      .handle("list", () => sessions.list())
      .handle("get", ({ params }) => sessions.get(params.id))
      .handle("delete", ({ params }) => sessions.remove(params.id))
      .handle("submit", ({ params, payload }) =>
        sessions.command(params.id, { _tag: "Prompt", ...payload }).pipe(Effect.map((value) => value as Submitted)))
      .handle("command", ({ params, payload }) =>
        sessions.command(params.id, payload).pipe(Effect.map((value) => ({ value: value as never }))))
      .handle("abort", ({ params, payload }) =>
        sessions.command(params.id, { _tag: "Abort", ...payload }).pipe(
          Effect.asVoid,
          Effect.catchTag("ConversationBusy", (error) => Effect.fail(new CommandFailed({ message: error._tag })))
        ))
      .handle("events", ({ params, query }) => sessions.events(params.id, parsePosition(query.after)))
      .handle("entries", ({ params, query }) =>
        sessions.entries(params.id, query).pipe(Effect.map((page) => page as { entries: Array<never>; next?: string })))
      .handle("conversations", ({ params }) =>
        sessions.conversations(params.id).pipe(Effect.map((items) => items as Array<never>)))
      .handle("submission", ({ params }) =>
        sessions.submission(params.id as SessionId, params.submissionId).pipe(Effect.map((record) => record as never)))
  })
)

const infoOf = (entry: VersionedCredential): CredentialInfo => ({
  providerId: entry.providerId,
  type: entry.credential.type,
  ...(entry.credential.type === "oauth" ? { expires: entry.credential.expires } : {}),
  updatedAt: entry.updatedAt
})

export const CredentialsApiLive = HttpApiBuilder.group(PublicApi, "credentials", Effect.fn(function*(handlers) {
  const credentials = yield* CredentialStore
  return handlers
    .handle("list", () => credentials.list().pipe(Effect.orDie, Effect.map((all) => all.map(infoOf))))
    .handle("put", ({ params, payload }) =>
      Effect.gen(function*() {
        yield* credentials.put(params.providerId, payload)
        const stored = yield* credentials.get(params.providerId)
        return infoOf(Option.getOrThrow(stored))
      }).pipe(Effect.orDie))
    .handle("delete", ({ params }) => credentials.remove(params.providerId).pipe(Effect.orDie))
}))

const info = { version: VERSION, servicesPath: SERVICES_PATH }

export const ServerApiLive = HttpApiBuilder.group(PublicApi, "server", Effect.fn(function*(handlers) {
  const config = yield* ControlPlaneConfig
  return handlers.handle("serverDetails", () =>
    Effect.succeed({
      ...info,
      defaultModel: config.defaultModel,
      defaultSandbox: config.defaultSandbox,
      sandboxTemplates: Object.keys(config.templates)
    }))
}))

export const SystemApiLive = HttpApiBuilder.group(PublicApi, "system", (handlers) =>
  handlers
    .handle("health", () => Effect.void)
    .handle("server", () => Effect.succeed(info)))

export const PublicApiHandlers = Layer.mergeAll(SessionsApiLive, CredentialsApiLive, ServerApiLive, SystemApiLive)
