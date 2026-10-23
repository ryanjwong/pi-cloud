import { parsePosition } from "@pi-cloud/core"
import { ChannelMessage, ChannelRequest, type CommandResult } from "@pi-cloud/protocol"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { type CommandError, Sessions, toJson } from "../Sessions.ts"
import { authorize, ClientAuth, guarded } from "./Auth.ts"

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

export const ChannelRoute = Layer.effectDiscard(Effect.gen(function*() {
  const router = yield* HttpRouter.HttpRouter
  const sessions = yield* Sessions
  const auth = yield* ClientAuth

  yield* router.add("GET", "/v1/sessions/:id/channel", guarded((headers) => authorize(auth, headers, "write"), () => Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const { id } = yield* HttpRouter.params
    const url = new URL(request.url, "http://localhost")

    const events = yield* sessions.events(id ?? "", parsePosition(url.searchParams.get("after") ?? undefined)).pipe(
      Effect.option
    )
    if (events._tag === "None") return HttpServerResponse.text("Session not found", { status: 404 })

    const socket = yield* Effect.orDie(request.upgrade)
    const writer = yield* socket.writer
    const reader = yield* socket.reader
    const send = (message: ChannelMessage) => writer.write(JSON.stringify(encode(message))).pipe(Effect.ignore)

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
    return HttpServerResponse.empty()
  })))
}))
