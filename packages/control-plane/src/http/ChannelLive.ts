import { parsePosition } from "@pi-cloud/core"
import { ChannelMessage, ChannelRequest, type CommandResult, type ViewUpdate } from "@pi-cloud/protocol"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { type CommandError, Sessions, toJson } from "../Sessions.ts"
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
 * WebSocket headers, `?token=<key>`. Resume from a known position with `?after=<epoch>:<seq>`.
 */
export const ChannelRoute = Layer.effectDiscard(Effect.gen(function*() {
  const router = yield* HttpRouter.HttpRouter
  const sessions = yield* Sessions
  const auth = yield* ClientAuth

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

    // The view: the session state once anything is watched, plus each watched conversation's view.
    const sessionId = id ?? ""
    const watched = new Map<number, Fiber.Fiber<unknown>>()
    let sessionState: Fiber.Fiber<unknown> | undefined
    let epoch: number | undefined
    const forward = (select: (update: ViewUpdate) => boolean, onUpdate: (update: ViewUpdate) => Effect.Effect<void> = () => Effect.void) =>
      sessions.views(sessionId, select).pipe(
        Effect.flatMap(Stream.runForEach((update) => Effect.andThen(onUpdate(update), send({ _tag: "View", update })))),
        Effect.ignore,
        Effect.forkChild
      )
    const ensureWatched = (conversationId: number) =>
      sessions.watch(sessionId, conversationId).pipe(
        Effect.catch((error) => send({ _tag: "Error", message: `Cannot watch conversation ${conversationId}: ${error._tag}` })),
        Effect.forkChild,
        Effect.asVoid
      )
    const watch = (conversationId: number) =>
      Effect.gen(function*() {
        // A new runner publishes only the root; ask it again for the other conversations being watched.
        sessionState ??= yield* forward((update) => update.conversationId === undefined, (update) =>
          Effect.gen(function*() {
            if (update.frame._tag !== "Snapshot" || update.epoch === epoch) return
            const restarted = epoch !== undefined
            epoch = update.epoch
            if (restarted) {
              for (const other of watched.keys()) if (other !== ROOT_CONVERSATION_ID) yield* ensureWatched(other)
            }
          }))
        if (watched.has(conversationId)) return
        watched.set(conversationId, yield* forward((update) => update.conversationId === conversationId))
        yield* ensureWatched(conversationId)
      })
    const unwatch = (conversationId: number) =>
      Effect.gen(function*() {
        const fiber = watched.get(conversationId)
        watched.delete(conversationId)
        if (fiber !== undefined) yield* Fiber.interrupt(fiber)
      })

    const handle = (text: string) =>
      decode(text).pipe(
        Effect.matchEffect({
          onFailure: (error) => send({ _tag: "Error", message: `Invalid request: ${error.message}` }),
          onSuccess: (message) => {
            if (message._tag === "Ping") return send({ _tag: "Pong", id: message.id })
            if (message._tag === "Watch") return watch(message.conversationId ?? ROOT_CONVERSATION_ID)
            if (message._tag === "Unwatch") return unwatch(message.conversationId ?? ROOT_CONVERSATION_ID)
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
    yield* Fiber.interruptAll([...watched.values(), ...(sessionState === undefined ? [] : [sessionState])])
    return HttpServerResponse.empty()
  }))
}))
