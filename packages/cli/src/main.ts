#!/usr/bin/env node
// pi-cloud: Pi's TUI on a session that runs entirely in the cloud.
//   PI_CLOUD_URL=https://pi.example.com pi-cloud            (in a git checkout)
import { NodeRuntime } from "@effect/platform-node"
import { type CommandResult, followEvents, openChannel, PiCloud } from "@pi-cloud/client"
import { runTui } from "@pi-cloud/tui"
import { Deferred, Effect, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import { importFromCodex, importFromPi, listCredentials, login, loginProviders, logout } from "./login.ts"
import { makeRenderer } from "./render.ts"

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    title: { type: "string" },
    instructions: { type: "string" },
    sandbox: { type: "string" },
    continue: { type: "boolean", short: "c" },
    resume: { type: "string", short: "r" },
    "from-pi": { type: "boolean" },
    "from-codex": { type: "boolean" },
    url: { type: "string" }
  }
})
const [command = "tui", ...rest] = positionals
const write = (text: string) => void process.stdout.write(text)

const usage = `pi-cloud [-c | -r <id>] [--model provider/model]
      Pi's TUI on a cloud session. In a git checkout the agent works in a cloud clone of its origin at the
      current branch; -c continues this repository's latest session, -r attaches to any session.

pi-cloud login [provider] [--from-pi | --from-codex]
      sign in to a model provider (ChatGPT/Codex: openai-codex, Claude Pro/Max: anthropic, ...) in your browser and
      store the login on the server, for every session; --from-pi / --from-codex import an existing Pi or Codex login
pi-cloud logout <provider>                    remove a stored credential
pi-cloud auth                                 list stored credentials

pi-cloud <command>

  new  [--model provider/model] [--title t] [--sandbox template]
                                              create a session, print its id; --sandbox names the template
                                              (from the runner's SANDBOX_TEMPLATES_FILE) the agent works in
  ls                                          list sessions
  chat [id] [--model ...] [--sandbox ...]      talk to a session (creates one without an id)
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
        ...(flags.sandbox === undefined ? {} : { sandbox: flags.sandbox }),
        ...(flags.instructions === undefined ? {} : { instructions: flags.instructions })
      }
    }
  })
})

/** The checkout's origin and branch, which the cloud session clones. */
const gitOrigin = () => {
  const git = (...args: Array<string>) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  try {
    const remote = git("remote", "get-url", "origin")
    const branch = git("rev-parse", "--abbrev-ref", "HEAD")
    // SSH remotes are cloned over HTTPS in the cloud, with the server's credential.
    const url = remote.replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/")
    const name = url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "")
    let unpushed = ""
    try {
      const ahead = Number(git("rev-list", "--count", `origin/${branch}..HEAD`))
      const dirty = git("status", "--porcelain").length > 0
      unpushed = [ahead > 0 ? `${ahead} unpushed commit${ahead === 1 ? "" : "s"}` : "", dirty ? "uncommitted changes" : ""]
        .filter(Boolean).join(" and ")
    } catch {
      unpushed = `branch ${branch} is not on origin`
    }
    return { url, branch, label: `${name}@${branch}`, unpushed }
  } catch {
    return undefined
  }
}

/** A session whose agent works in a cloud sandbox: a clone of this checkout's origin, or an empty directory. */
const cloudSession = Effect.gen(function*() {
  const client = yield* PiCloud
  const origin = gitOrigin()
  const provider = process.env.PI_CLOUD_SANDBOX_PROVIDER ?? "local"
  if (origin?.unpushed) write(`Note: the cloud session works from origin; ${origin.unpushed} are not there.\n`)
  const session = yield* client.sessions.create({
    payload: {
      title: flags.title ?? origin?.label,
      spec: {
        model: parseModel(flags.model ?? process.env.PI_CLOUD_MODEL ?? "anthropic/claude-opus-5-5"),
        sandbox: "home",
        sandboxes: {
          home: origin === undefined
            ? { provider }
            : { provider, repository: { url: origin.url, ref: origin.branch, credential: "GITHUB_TOKEN" } }
        },
        ...(origin === undefined ? {} : { metadata: { origin: { url: origin.url, branch: origin.branch } } }),
        ...(flags.instructions === undefined ? {} : { instructions: flags.instructions })
      }
    }
  })
  return { session, label: origin?.label }
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
    case "tui": {
      let target: { readonly id: string; readonly label?: string | undefined } | undefined
      if (flags.resume !== undefined) target = { id: (yield* client.sessions.get({ params: { id: flags.resume as never } })).id }
      else if (flags.continue === true) {
        const origin = gitOrigin()
        const matching = (yield* client.sessions.list()).filter((candidate) => {
          const saved = (candidate.spec.metadata?.origin ?? undefined) as { url?: string; branch?: string } | undefined
          return origin === undefined ? saved === undefined : saved?.url === origin.url && saved.branch === origin.branch
        })
        const latest = [...matching].sort((a, b) => b.createdAt - a.createdAt)[0]
        if (latest !== undefined) target = { id: latest.id, label: origin?.label }
        else write("No session for this repository yet; starting one.\n")
      }
      if (target === undefined) {
        const created = yield* cloudSession
        target = { id: created.session.id, label: created.label }
      }
      const { id, label } = target
      return yield* Effect.promise(() => runTui({ ...connection, sessionId: id, ...(label === undefined ? {} : { label }) }))
    }
    case "login": {
      const attempt = (run: () => Promise<void>) =>
        Effect.promise(() =>
          run().catch((error) => {
            process.exitCode = 1
            write(`Login failed: ${error instanceof Error ? error.message : String(error)}\n`)
          })
        )
      const provider = rest[0]
      if (flags["from-codex"] === true) return yield* attempt(() => importFromCodex(connection))
      if (flags["from-pi"] === true) return yield* attempt(() => importFromPi(connection, rest))
      if (provider === undefined) {
        write(`pi-cloud login <provider>\n\n${loginProviders().map((entry) => `  ${entry.id.padEnd(16)} ${entry.name}`).join("\n")}\n`)
        return
      }
      return yield* attempt(() => login(connection, provider))
    }
    case "logout": {
      if (rest[0] === undefined) return write(`${usage}\n`)
      return yield* Effect.promise(() => logout(connection, rest[0]!))
    }
    case "auth":
      return yield* Effect.promise(() => listCredentials(connection))
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
