#!/usr/bin/env node
// pi-cloud: a terminal projection of the public API.
//   PI_CLOUD_URL=http://127.0.0.1:8787 pi-cloud chat --model anthropic/claude-opus-5-5
import { NodeRuntime } from "@effect/platform-node"
import { followEvents, PiCloud } from "@pi-cloud/client"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import { makeRenderer } from "./render.ts"

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    title: { type: "string" },
    instructions: { type: "string" },
    url: { type: "string" }
  }
})
const [command = "help", ...rest] = positionals
const write = (text: string) => void process.stdout.write(text)

const usage = `pi-cloud <command>

  new  [--model provider/model] [--title t]   create a session, print its id
  ls                                          list sessions
  chat [id] [--model provider/model]          talk to a session (creates one without an id)
  send <id> <message...>                      send one message and stream the answer
  tail <id>                                   print a session's live events
  rm   <id>                                   delete a session

  PI_CLOUD_URL (default http://127.0.0.1:8787), PI_CLOUD_API_KEY`

const createSession = Effect.gen(function*() {
  const client = yield* PiCloud
  const [provider, ...modelId] = (flags.model ?? "anthropic/claude-opus-5-5").split("/")
  return yield* client.sessions.create({
    payload: {
      title: flags.title,
      spec: {
        model: { provider: provider!, modelId: modelId.join("/") },
        ...(flags.instructions === undefined ? {} : { instructions: flags.instructions })
      }
    }
  })
})

/** Render a session's live events. */
const watch = (sessionId: string, options: {
  readonly history: boolean
  /** Only render the run that takes the submission made with this request id. */
  readonly only?: string
  /** Called when that run ends. */
  readonly onDone?: () => void
}) => {
  const renderEvent = makeRenderer(write)
  let started = options.only === undefined
  let mine: number | undefined
  return followEvents(sessionId).pipe(
    Stream.runForEach((batch) =>
      Effect.sync(() => {
        for (
          const event of batch.events as ReadonlyArray<{
            type: string
            inputs?: ReadonlyArray<number>
            record?: { id: number; requestId?: string }
          }>
        ) {
          if (event.type === "submission" && event.record?.requestId === options.only) mine = event.record?.id
          if (event.type === "snapshot" && !options.history) continue
          if (!started) {
            if (event.type !== "run_start" || mine === undefined || !event.inputs?.includes(mine)) continue
            started = true
          }
          renderEvent(event)
          if (event.type === "run_end" && mine !== undefined && event.inputs?.includes(mine)) options.onDone?.()
        }
      })
    )
  )
}

const send = (sessionId: string, content: string) =>
  Effect.gen(function*() {
    const client = yield* PiCloud
    const done = yield* Deferred.make<void>()
    const requestId = crypto.randomUUID()
    const fiber = yield* Effect.forkChild(watch(sessionId, {
      history: false,
      only: requestId,
      onDone: () => Effect.runSync(Deferred.succeed(done, undefined))
    }))
    yield* Effect.sleep(200)
    yield* client.sessions.submit({ params: { id: sessionId as never }, payload: { content, requestId } })
    yield* Deferred.await(done)
    yield* Fiber.interrupt(fiber)
  })

const program = Effect.gen(function*() {
  const client = yield* PiCloud
  switch (command) {
    case "new": {
      const session = yield* createSession
      return write(`${session.id}\n`)
    }
    case "ls": {
      for (const session of yield* client.sessions.list()) {
        const model = session.spec.model === undefined ? "" : `${session.spec.model.provider}/${session.spec.model.modelId}`
        write(`${session.id}  ${session.runner.state.padEnd(8)}  ${model}  ${session.title ?? ""}\n`)
      }
      return
    }
    case "send": {
      const [id, ...words] = rest
      if (id === undefined || words.length === 0) return write(`${usage}\n`)
      return yield* send(id, words.join(" "))
    }
    case "tail": {
      if (rest[0] === undefined) return write(`${usage}\n`)
      return yield* watch(rest[0], { history: true })
    }
    case "rm": {
      if (rest[0] === undefined) return write(`${usage}\n`)
      return yield* client.sessions.delete({ params: { id: rest[0] as never } })
    }
    case "chat": {
      const id = rest[0] ?? (yield* createSession).id
      write(`session ${id}\n`)
      const { entries } = yield* client.sessions.entries({ params: { id: id as never }, query: { limit: 1000 } })
      makeRenderer(write)({ type: "snapshot", entries })
      const input = createInterface({ input: process.stdin, output: process.stdout })
      while (true) {
        const line = yield* Effect.promise(() => input.question("› ").catch(() => "/quit"))
        if (line.trim() === "/quit") break
        if (line.trim() === "") continue
        yield* send(id, line)
      }
      input.close()
      return
    }
    default:
      return write(`${usage}\n`)
  }
})

program.pipe(
  Effect.provide(PiCloud.layer({
    url: flags.url ?? process.env.PI_CLOUD_URL ?? "http://127.0.0.1:8787",
    apiKey: process.env.PI_CLOUD_API_KEY
  })),
  NodeRuntime.runMain
)
