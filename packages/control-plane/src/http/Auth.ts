import { allows, ApiAuth, bearerOf, type Client, Forbidden, type Scope, secretsEqual, Unauthorized } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Redacted } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createHash } from "node:crypto"

type Headers = Readonly<Record<string, string | undefined>>

export interface ApiKey {
  readonly name: string
  readonly sha256: string
  readonly scopes: ReadonlyArray<Scope>
}

export interface AuthSettings {
  readonly keys?: ReadonlyArray<ApiKey> | undefined
  readonly allowedOrigins?: ReadonlyArray<string> | undefined
  readonly allowedHosts?: ReadonlyArray<string> | undefined
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

export const adminKeys = (tokens: ReadonlyArray<string>): Array<ApiKey> =>
  tokens.map((token, index) => ({ name: `admin-${index + 1}`, sha256: sha256(token), scopes: ["admin"] }))

export const isLoopback = (host: string) => ["127.0.0.1", "::1", "localhost"].includes(host) || host.startsWith("127.")

export const loopbackHosts = (host: string, ...extra: ReadonlyArray<string>) =>
  isLoopback(host) ? ["127.0.0.1", "localhost", "[::1]", host, ...extra] : undefined

export class RunnerAuth extends Context.Service<RunnerAuth, {
  check(headers: Headers): Effect.Effect<void, Unauthorized>
}>()("@pi-cloud/control-plane/RunnerAuth") {
  static readonly sharedSecret = (secret: string): Layer.Layer<RunnerAuth> =>
    Layer.succeed(RunnerAuth, {
      check: (headers) =>
        secretsEqual(bearerOf(headers) ?? "", secret)
          ? Effect.void
          : Effect.fail(new Unauthorized({ message: "Invalid runner credentials" }))
    })
}

export class ClientAuth extends Context.Service<ClientAuth, {
  check(token: string | undefined): Effect.Effect<Client, Unauthorized>
}>()("@pi-cloud/control-plane/ClientAuth") {
  static readonly keys = (keys: ReadonlyArray<ApiKey>): Layer.Layer<ClientAuth> =>
    Layer.succeed(ClientAuth, {
      check: (token) => {
        const hash = sha256(token ?? "")
        const key = keys.reduce<ApiKey | undefined>((found, key) => secretsEqual(hash, key.sha256) ? key : found, undefined)
        return token === undefined || key === undefined
          ? Effect.fail(new Unauthorized({ message: "Missing or invalid API key" }))
          : Effect.succeed({ kind: "client", id: key.sha256.slice(0, 12), name: key.name, scopes: key.scopes })
      }
    })
}

export const authorize = (auth: ClientAuth["Service"], headers: Headers, scope: Scope) =>
  auth.check(bearerOf(headers)).pipe(
    Effect.filterOrFail((client) => allows(client, scope), () => new Forbidden({ message: `This key lacks the ${scope} scope` }))
  )

export const guarded = <A, E, R>(
  check: (headers: Headers) => Effect.Effect<A, Unauthorized | Forbidden>,
  handler: (value: A) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.matchEffect(check(request.headers), {
      onFailure: (error) => Effect.succeed(HttpServerResponse.text(error.message, { status: error._tag === "Unauthorized" ? 401 : 403 })),
      onSuccess: handler
    }))

const scopeOf = (group: string, method: string): Scope => group === "credentials" ? "admin" : method === "GET" ? "read" : "write"

export const ApiAuthLive: Layer.Layer<ApiAuth, never, ClientAuth> = Layer.effect(
  ApiAuth,
  Effect.gen(function*() {
    const auth = yield* ClientAuth
    return ApiAuth.of({
      bearer: (httpEffect, { credential, endpoint, group }) =>
        Effect.andThen(
          authorize(auth, { authorization: `Bearer ${Redacted.value(credential)}` }, scopeOf(group.identifier, endpoint.method)),
          httpEffect
        )
    })
  })
)

export const requestGuard = (settings: AuthSettings) => {
  const origins = settings.allowedOrigins ?? []
  const allowed = (headers: Headers) =>
    (headers["origin"] === undefined || origins.includes(headers["origin"])) &&
    (settings.allowedHosts === undefined || settings.allowedHosts.includes((headers["host"] ?? "").replace(/:\d+$/, "")))
  return Layer.mergeAll(
    HttpRouter.middleware((httpEffect) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        allowed(request.headers) ? httpEffect : Effect.succeed(HttpServerResponse.text("Forbidden origin or host", { status: 403 }))), { global: true }),
    origins.length === 0 ? Layer.empty : HttpRouter.cors({ allowedOrigins: origins, allowedHeaders: ["authorization", "content-type"] })
  )
}
