import {
  ChannelMessage,
  type ChannelRequest,
  channelPath,
  type CommandResult,
  type EventBatch,
  type SessionCommand,
  type WorkspaceCall,
  type WorkspaceEvent
} from "@pi-cloud/protocol"
import { type Cause, Deferred, Effect, Queue, Schema, type Scope, Stream } from "effect"
import { Socket } from "effect/socket"
import type { ClientOptions } from "./index.ts"

/** A live, two-way connection to one session. */
export interface SessionChannel {
  /** Buffered then live event batches, until the channel closes. */
  readonly events: Stream.Stream<EventBatch>
  /** Run a command and wait for its result. */
  command(command: SessionCommand): Effect.Effect<CommandResult, Socket.SocketError>
}

/** Runs workspace calls on this machine; `serveWorkspace` from `@pi-cloud/workspace` is one. */
export interface WorkspaceHandler {
  call(id: string, call: WorkspaceCall, emit: (event: WorkspaceEvent) => void): void
  cancel(id: string): void
}

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelMessage))
const textDecoder = new TextDecoder()

/**
 * Open the session channel (`GET /v1/sessions/{id}/channel`). The connection lives as long as the scope; the API
 * key travels as `?token=` because WebSocket clients cannot always set headers.
 */
export const openChannel = (
  options: ClientOptions & {
    readonly sessionId: string
    readonly after?: string | undefined
    /** Serve the session's workspace from this connection. */
    readonly workspace?: WorkspaceHandler | undefined
  }
): Effect.Effect<SessionChannel, Socket.SocketError, Scope.Scope> =>
  Effect.gen(function*() {
    const url = new URL(channelPath(options.sessionId), options.url)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    if (options.apiKey !== undefined) url.searchParams.set("token", options.apiKey)
    if (options.after !== undefined) url.searchParams.set("after", options.after)

    const socket = yield* Socket.makeWebSocket(url.toString()).pipe(
      Effect.provide(Socket.layerWebSocketConstructorGlobal)
    )
    const writer = yield* socket.writer
    const reader = yield* socket.reader
    const events = yield* Queue.unbounded<EventBatch, Socket.SocketError | Cause.Done>()
    const pending = new Map<string, Deferred.Deferred<CommandResult>>()
    // Everything sent goes through one queue, so replies emitted from callbacks keep their order.
    const outgoing = yield* Queue.unbounded<string>()
    yield* Queue.take(outgoing).pipe(Effect.flatMap((text) => writer.write(text)), Effect.forever, Effect.ignore, Effect.forkScoped)
    const send = (request: ChannelRequest) => Effect.asVoid(Queue.offer(outgoing, JSON.stringify(request)))
    const workspace = options.workspace

    const receive = (text: string) =>
      Effect.gen(function*() {
        const message = decode(text)
        switch (message._tag) {
          case "Events":
            return yield* Queue.offer(events, message.batch)
          case "Result": {
            const deferred = pending.get(message.id)
            pending.delete(message.id)
            if (deferred !== undefined) yield* Deferred.succeed(deferred, message.result)
            return
          }
          case "WorkspaceCall":
            return workspace?.call(message.id, message.call, (event) => {
              Queue.offerUnsafe(outgoing, JSON.stringify({ _tag: "WorkspaceReply", id: message.id, event } satisfies ChannelRequest))
            })
          case "WorkspaceCancel":
            return workspace?.cancel(message.id)
          case "Error": {
            const deferred = message.id === undefined ? undefined : pending.get(message.id)
            if (deferred !== undefined) {
              yield* Deferred.succeed(deferred, { _tag: "Err", tag: "ChannelError", message: message.message })
            }
            return
          }
          default:
            return
        }
      })

    yield* reader.pull.pipe(
      Effect.flatMap((chunks) =>
        Effect.forEach(chunks, (chunk) => receive(typeof chunk === "string" ? chunk : textDecoder.decode(chunk)), {
          discard: true
        })
      ),
      Effect.forever,
      Effect.catch((error) => Queue.fail(events, error)),
      Effect.forkScoped
    )

    if (workspace !== undefined) yield* send({ _tag: "ServeWorkspace" })

    return {
      events: Stream.fromQueue(events).pipe(Stream.catchCause(() => Stream.empty)),
      command: (command) =>
        Effect.gen(function*() {
          const id = crypto.randomUUID()
          const deferred = yield* Deferred.make<CommandResult>()
          pending.set(id, deferred)
          yield* send({ _tag: "Command", id, command })
          return yield* Deferred.await(deferred)
        })
    } satisfies SessionChannel
  })

