import { createHost, type Host, invalid, replicatedState, type WebSocketLike, webSocketLink } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { SessionStore } from "@pi-cloud/core"
import {
  type CloudSession,
  type Principal,
  principalKey,
  SERVER_HOST,
  type SessionId,
  SessionSpec,
  sessionOfHost,
  SessionsObject,
  type SessionView
} from "@pi-cloud/protocol"
import { Context as EffectContext, Deferred, Effect, Layer, Option, Schedule, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Socket } from "effect/socket"
import { Type } from "typebox"
import { ClientAuth } from "../http/Auth.ts"
import { Runners } from "../Runners.ts"
import { Sessions } from "../Sessions.ts"

/** The WebSocket path of the service API. */
export const SERVICES_PATH = "/v1/pi"

const Anything = Type.Unsafe<any>(Type.Unknown())

/**
 * The control plane's side of the service API (`Services.ts` in `@pi-cloud/protocol`): the Chord host `server`. It
 * serves the session directory, accepts presentations over WebSockets at `/v1/pi`, and routes every `session:<id>`
 * reference to the runner hosting that session, waking one when needed.
 */
export class ServiceHost extends EffectContext.Service<ServiceHost, {
  readonly host: Host<Principal>
}>()("@pi-cloud/control-plane/ServiceHost") {
  static readonly layer = Layer.effect(ServiceHost, Effect.gen(function*() {
    const sessions = yield* Sessions
    const runners = yield* Runners
    const store = yield* SessionStore
    const auth = yield* ClientAuth
    const router = yield* HttpRouter.HttpRouter
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
    const decodeSpec = Schema.decodeUnknownSync(SessionSpec)

    const host = createHost<Principal>({
      name: SERVER_HOST,
      self: { kind: "host" },
      principalKey,
      onError: (error) => Effect.runFork(Effect.logWarning("service host", error instanceof Error ? error.message : String(error)))
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => host.close().catch(() => {})))

    // ----- The session directory, kept current: sessions also change through REST, triggers and runners.
    const cloudOf = (session: SessionView): CloudSession => ({
      id: session.id,
      title: session.title ?? null,
      createdAt: session.createdAt,
      spec: JSON.parse(JSON.stringify(session.spec)),
      runner: { state: session.runner.state, runnerId: session.runner.runnerId ?? null }
    })
    const listed = async () => [...await run(sessions.list())].sort((a, b) => a.createdAt - b.createdAt).map(cloudOf)
    const directory = replicatedState<{ list: Array<CloudSession> }>({ list: yield* Effect.promise(listed) })
    let lastListing = JSON.stringify(directory.value.list)
    const refresh = async () => {
      const list = await listed()
      const listing = JSON.stringify(list)
      if (listing === lastListing) return
      lastListing = listing
      directory.replace(BACKGROUND_CONTEXT, { list })
    }
    yield* Effect.promise(refresh).pipe(Effect.ignore, Effect.repeat(Schedule.spaced(1_000)), Effect.forkScoped)

    host.serve(SessionsObject, (_input, _principal, self) => {
      const list = self.state("sessions", Anything, { init: () => directory.value.list })
      self.on("sessions", directory, (value, ctx) => list.replace(ctx, value.list))
      return {
        variant: "default",
        sessions: list,
        create: async ({ title, spec }) => {
          const created = await run(sessions.create({
            ...(title === undefined ? {} : { title }),
            ...(spec === undefined ? {} : { spec: decodeSpec(spec) })
          }))
          await refresh()
          return cloudOf(created)
        },
        remove: async ({ id }) => {
          await run(Effect.orDie(sessions.remove(id as SessionId)))
          await refresh()
        }
      }
    })

    // ----- Sessions' hosts are their runners, reached over each runner's lease-fenced channel.
    host.route("session:", {
      authorize: (principal) => principal.kind !== "runner",
      resolve: async (name) => {
        const sessionId = sessionOfHost(name) ?? ""
        const session = await run(store.get(sessionId as SessionId).pipe(Effect.orDie))
        if (Option.isNone(session)) throw invalid("not_found", `Unknown session: ${sessionId}`)
        return run(runners.link(session.value))
      },
      principal: (name) => ({ kind: "runner", session: sessionOfHost(name) ?? "" })
    })

    // ----- Presentations: one Chord link per WebSocket, as clients.
    yield* router.add("GET", SERVICES_PATH, Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://localhost")
      const bearer = request.headers["authorization"]?.replace(/^Bearer\s+/i, "")
      const authorized = yield* auth.check(bearer ?? url.searchParams.get("token") ?? undefined).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false)
      )
      if (!authorized) return HttpServerResponse.text("Unauthorized", { status: 401 })

      const socket = yield* Effect.orDie(request.upgrade)
      const writer = yield* socket.writer
      const reader = yield* socket.reader
      const closed = yield* Deferred.make<void>()
      const listeners = { message: [] as Array<(event: { readonly data: unknown }) => void>, close: [] as Array<() => void> }
      let open = true
      const end = () => {
        if (!open) return
        open = false
        for (const listener of listeners.close) listener()
        Effect.runSync(Deferred.succeed(closed, undefined))
      }
      const like: WebSocketLike = {
        get readyState() {
          return open ? 1 : 3
        },
        send: (data) => void Effect.runFork(writer.write(data).pipe(Effect.ignore)),
        close: (code, reason) => {
          void Effect.runFork(writer.write(new Socket.CloseEvent(code ?? 1000, reason)).pipe(Effect.ignore))
          end()
        },
        addEventListener: ((type: "message" | "open" | "close" | "error", listener: (event: { readonly data: unknown }) => void) => {
          if (type === "message") listeners.message.push(listener)
          else if (type === "close" || type === "error") listeners.close.push(listener as () => void)
        }) as WebSocketLike["addEventListener"]
      }
      host.accept(webSocketLink(like, { acceptPacked: false }), { principal: { kind: "client" }, kind: "client" })
      yield* reader.pull.pipe(
        Effect.flatMap((chunks) =>
          Effect.sync(() => {
            for (const data of chunks) for (const listener of listeners.message) listener({ data })
          })
        ),
        Effect.forever,
        Effect.ignore,
        Effect.raceFirst(Deferred.await(closed))
      )
      end()
      return HttpServerResponse.empty()
    }))

    return ServiceHost.of({ host })
  }))
}
