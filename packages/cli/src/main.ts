#!/usr/bin/env node
// pi-cloud: a terminal projection of the public API.
//   PI_CLOUD_URL=http://127.0.0.1:8787 pi-cloud chat --model anthropic/claude-opus-5-5
import { NodeRuntime } from "@effect/platform-node"
import { type CommandResult, followEvents, openChannel, PiCloud } from "@pi-cloud/client"
import { Deferred, Effect, Stream } from "effect"
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
  return yield* client.sessions.create({
    payload: {
      title: flags.title,
      spec: {
        model: parseModel(flags.model ?? "anthropic/claude-opus-5-5"),
        ...(flags.instructions === undefined ? {} : { instructions: flags.instructions })
      }
    }
  })
})

const connection = {
  url: flags.url ?? process.env.PI_CLOUD_URL ?? "http://127.0.0.1:8787",
  apiKey: process.env.PI_CLOUD_API_KEY
}

const parseModel = (value: string) => {
  const [provider, ...modelId] = value.split("/")
  return { provider: provider!, modelId: modelId.join("/") }
}

/**
 * Talk to a session over its channel: render its events, send prompts, and wait for each prompt's run to end.
 * Lines starting with `/` are agent commands.
 */
const converse = (sessionId: string, lines: AsyncIterable<string>, options: { readonly history: boolean }) =>
  Effect.gen(function*() {
    const channel = yield* openChannel({ ...connection, sessionId })
    const render = makeRenderer(write)
    let renderedSnapshot = !options.history
    let awaiting: { requestId: string; submissionId?: number; done: Deferred.Deferred<void> } | undefined

    yield* channel.events.pipe(
      Stream.runForEach((batch) =>
        Effect.sync(() => {
          for (const event of batch.events as ReadonlyArray<{ type: string; [key: string]: any }>) {
            if (event.type === "snapshot") {
              if (!renderedSnapshot) render(event)
              renderedSnapshot = true
              continue
            }
            if (event.type === "submission" && event.record?.requestId === awaiting?.requestId) {
              awaiting!.submissionId = event.record.id
            }
            render(event)
            if (event.type === "run_end" && awaiting?.submissionId !== undefined && event.inputs?.includes(awaiting.submissionId)) {
              Effect.runSync(Deferred.succeed(awaiting.done, undefined))
            }
          }
        })
      ),
      Effect.forkScoped
    )

    const report = (result: CommandResult) =>
      Effect.sync(() => write(result._tag === "Ok" ? "  ok\n" : `  ✗ ${result.tag}: ${result.message}\n`))

    const iterator = lines[Symbol.asyncIterator]()
    while (true) {
      const next = yield* Effect.promise(() => iterator.next())
      if (next.done === true) break
      const line = next.value.trim()
      if (line === "") continue
      if (line === "/quit") break
      if (line === "/abort") yield* report(yield* channel.command({ _tag: "Abort" }))
      else if (line === "/compact") yield* report(yield* channel.command({ _tag: "Compact" }))
      else if (line.startsWith("/reset")) {
        const handoff = line.slice("/reset".length).trim()
        yield* report(yield* channel.command({ _tag: "Reset", handoff: handoff || undefined }))
      } else if (line.startsWith("/model ")) {
        yield* report(yield* channel.command({ _tag: "Configure", model: parseModel(line.slice(7).trim()) }))
      } else {
        const done = yield* Deferred.make<void>()
        awaiting = { requestId: crypto.randomUUID(), done }
        const result = yield* channel.command({ _tag: "Prompt", content: line, requestId: awaiting.requestId })
        if (result._tag === "Err") yield* report(result)
        else yield* Deferred.await(done)
      }
    }
  }).pipe(Effect.scoped)

/** Lines typed at a prompt (or piped in), until end of input. */
async function* typed(): AsyncGenerator<string> {
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
  input.setPrompt("› ")
  input.prompt()
  for await (const line of input) {
    yield line
    input.prompt()
  }
}

async function* once(line: string): AsyncGenerator<string> {
  yield line
}

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
      return yield* converse(id, once(words.join(" ")), { history: false })
    }
    case "tail": {
      if (rest[0] === undefined) return write(`${usage}\n`)
      const render = makeRenderer(write)
      return yield* followEvents(rest[0]).pipe(
        Stream.runForEach((batch) => Effect.sync(() => batch.events.forEach((event) => render(event as never))))
      )
    }
    case "rm": {
      if (rest[0] === undefined) return write(`${usage}\n`)
      return yield* client.sessions.delete({ params: { id: rest[0] as never } })
    }
    case "chat": {
      const id = rest[0] ?? (yield* createSession).id
      write(`session ${id}  (/model provider/id, /compact, /reset [note], /abort, /quit)\n`)
      return yield* converse(id, typed(), { history: true })
    }
    default:
      return write(`${usage}\n`)
  }
})

program.pipe(
  Effect.provide(PiCloud.layer(connection)),
  NodeRuntime.runMain
)
