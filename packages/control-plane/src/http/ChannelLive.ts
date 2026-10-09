import { parsePosition } from "@pi-cloud/core"
import { ChannelMessage, ChannelRequest, type CommandResult } from "@pi-cloud/protocol"
import { Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { type CommandError, Sessions, toJson } from "../Sessions.ts"
import { type WorkspaceReplies, Workspaces } from "../Workspaces.ts"
import { ClientAuth } from "./Auth.ts"

const encode = Schema.encodeSync(ChannelMessage)
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ChannelRequest))
const textDecoder = new TextDecoder()

const resultOf = (error: CommandError): CommandResult => {
  switch (error._tag) {
    case "CommandFailed":
      return { _tag: "Err", tag: error.reason ?? error._tag, message: error.message }
    case "RunnerUnavailable":
      return { _tag: "Err", tag: error._tag, message: error.message }
    default:
      return { _tag: "Err", tag: error._tag, message: error._tag }
  }
}

/**
 * `GET /v1/sessions/{id}/channel`: the session channel, a WebSocket carrying `ChannelRequest`s in and
 * `ChannelMessage`s out. Authenticates with `Authorization: Bearer <key>` or, for browsers that cannot set
 * WebSocket headers, `?token=<key>`. Resume from a known position with `?after=<epoch>:<seq>`. After
 * `ServeWorkspace`, the connection also serves the session's workspace until it closes. `?stream=view` carries the
 * replicated view (for Pi's TUI) instead of Pi's agent events.
 */
export const ChannelRoute = Layer.effectDiscard(Effect.gen(function*() {
  const router = yield* HttpRouter.HttpRouter
  const sessions = yield* Sessions
  const auth = yield* ClientAuth
  const workspaces = yield* Workspaces

  yield* router.add("GET", "/v1/sessions/:id/channel", Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const { id } = yield* HttpRouter.params
    const url = new URL(request.url, "http://localhost")
    const bearer = request.headers["authorization"]?.replace(/^Bearer\s+/i, "")
    const authorized = yield* auth.check(bearer ?? url.searchParams.get("token") ?? undefined).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    )
    if (!authorized) return HttpServerResponse.text("Unauthorized", { status: 401 })

    const after = parsePosition(url.searchParams.get("after") ?? undefined)
    const events = yield* sessions.events(id ?? "", after, url.searchParams.get("stream") ?? undefined).pipe(
      Effect.option
    )
    if (events._tag === "None") return HttpServerResponse.text("Session not found", { status: 404 })

    const socket = yield* Effect.orDie(request.upgrade)
    const writer = yield* socket.writer
    const reader = yield* socket.reader
    const send = (message: ChannelMessage) => writer.write(JSON.stringify(encode(message))).pipe(Effect.ignore)
    // Serving the workspace lasts as long as this connection.
    const scope = yield* Scope.make()
    let replies: WorkspaceReplies | undefined

    const pump = yield* events.value.pipe(
      Stream.runForEach((batch) => send({ _tag: "Events", batch })),
      Effect.forkChild
    )

    const handle = (text: string) =>
      decode(text).pipe(
        Effect.matchEffect({
          onFailure: (error) => send({ _tag: "Error", message: `Invalid request: ${error.message}` }),
          onSuccess: (message) => {
            if (message._tag === "Ping") return send({ _tag: "Pong", id: message.id })
            if (message._tag === "ServeWorkspace") {
              return Effect.gen(function*() {
                replies ??= yield* Scope.provide(workspaces.serve(id ?? "", send), scope)
              })
            }
            if (message._tag === "WorkspaceReply") return replies?.(message.id, message.event) ?? Effect.void
            return sessions.command(id ?? "", message.command).pipe(
              Effect.map((value): CommandResult => ({ _tag: "Ok", value: toJson(value) as never })),
              Effect.catch((error) => Effect.succeed(resultOf(error))),
              Effect.flatMap((result) => send({ _tag: "Result", id: message.id, result })),
              Effect.forkChild,
              Effect.asVoid
            )
          }
        })
      )

    // Read until the client goes away, then stop streaming to it.
    yield* reader.pull.pipe(
      Effect.flatMap((chunks) =>
        Effect.forEach(chunks, (chunk) => handle(typeof chunk === "string" ? chunk : textDecoder.decode(chunk)), {
          discard: true
        })
      ),
      Effect.forever,
      Effect.ignore
    )
    yield* Fiber.interrupt(pump)
    yield* Scope.close(scope, Exit.void)
    return HttpServerResponse.empty()
  }))
}))
