#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node"
import { type CommandResult, followEvents, openChannel, PiCloud, VERSION } from "@pi-cloud/client"
import { runTui } from "@pi-cloud/tui"
import { Cause, Deferred, Effect, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import { githubAppCommand } from "./github-app.ts"
import { importFromCodex, importFromPi, listCredentials, login, loginProviders, logout } from "./login.ts"
import { makeRenderer } from "./render.ts"
import { rejected, resolveConnection, unreachable } from "./settings.ts"
import { deploy, doctor, init, update } from "./setup.ts"

const write = (text: string) => void process.stdout.write(text)
const fail = (error: unknown, hint = ""): never => {
  write(`${error instanceof Error ? error.message : String(error)}\n${hint}`)
  return process.exit(1)
}
const orExit = <A>(run: () => A, hint?: string): A => {
  try {
    return run()
  } catch (error) {
    return fail(error, hint)
  }
}
const { values: flags, positionals } = orExit(() => parseArgs({
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
    url: { type: "string" },
    org: { type: "string" },
    name: { type: "string" },
    secrets: { type: "string" },
    print: { type: "boolean" },
    manifest: { type: "boolean" },
    "api-key": { type: "string" },
    help: { type: "boolean", short: "h" }
  }
}), "Run pi-cloud --help for usage.\n")
const [command = "tui", ...rest] = positionals

const usage = `pi-cloud [-c | -r <id>] [--model provider/model]
      Pi's TUI on a cloud session. In a git checkout the agent works in a cloud clone of its origin at the
      current branch; -c continues this repository's latest session, -r attaches to any session.

pi-cloud login [provider] [--from-pi | --from-codex]
      sign in to a model provider (ChatGPT/Codex: openai-codex, Claude Pro/Max: anthropic, ...) in your browser and
      store the login on the server, for every session; --from-pi / --from-codex import an existing Pi or Codex login
pi-cloud github-app --url <public control plane URL> [--org acme] [--name pi-cloud] [--secrets file]
      create pi-cloud's GitHub App from its manifest in your browser (one click on GitHub), and store its ID,
      private key and webhook secret in ~/.config/pi-cloud/secrets.yaml or --secrets; --print prints them instead, --manifest prints the manifest
pi-cloud logout <provider>                    remove a stored credential
pi-cloud auth                                 list stored credentials

pi-cloud init                                 create the age key and secrets in ~/.config/pi-cloud
pi-cloud deploy cloudflare [--name pi-cloud]  deploy to Cloudflare and point this CLI at it
pi-cloud doctor                               check the tools, secrets, server and API key
pi-cloud update                               update pi-cloud from GitHub, then redeploy every target

pi-cloud <command>

  new  [--model provider/model] [--title t] [--sandbox template]
                                              create a session, print its id; --sandbox names the template
                                              (from the server config) the agent works in
  ls                                          list sessions
  chat [id] [--model ...] [--sandbox ...]      talk to a session (creates one without an id)
  send <id> <message...>                      send one message and stream the answer
  tail <id>                                   print a session's live events
  rm   <id>                                   delete a session

  Connects to the target saved by \`pi-cloud deploy\` (~/.config/pi-cloud/config.json), else http://127.0.0.1:8787.
  --url and --api-key, then PI_CLOUD_URL and PI_CLOUD_API_KEY, override it.`

if (flags.help === true || command === "help") {
  write(`${usage}\n`)
  process.exit()
}
const setup = () => {
  switch (command) {
    case "init":
      return init()
    case "deploy":
      return deploy(rest[0], flags.name)
    case "doctor":
      return doctor(flags.url, flags["api-key"])
    case "update":
      return update()
    case "github-app":
      return githubAppCommand(flags, write)
    default:
      return undefined
  }
}
const local = setup()
if (local !== undefined) {
  await local.catch(fail)
  process.exit()
}

const defaultModel = Effect.gen(function*() {
  const server = yield* Effect.flatMap(PiCloud, (client) => client.serverDetails()).pipe(Effect.orElseSucceed(() => undefined))
  if (server !== undefined && server.version !== VERSION) {
    process.stderr.write(`Note: pi-cloud at ${connection.url} runs ${server.version} and this CLI ${VERSION}; run \`pi-cloud update\`.\n`)
  }
  return parseModel(flags.model ?? process.env.PI_CLOUD_MODEL ?? server?.defaultModel ?? "anthropic/claude-opus-5-5")
})

const createSession = Effect.gen(function*() {
  const client = yield* PiCloud
  const model = yield* defaultModel
  return yield* client.sessions.create({
    payload: {
      title: flags.title,
      spec: {
        model,
        ...(flags.sandbox === undefined ? {} : { sandbox: flags.sandbox }),
        ...(flags.instructions === undefined ? {} : { instructions: flags.instructions })
      }
    }
  })
})

const gitOrigin = () => {
  const git = (...args: Array<string>) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  try {
    const remote = git("remote", "get-url", "origin")
    const branch = git("rev-parse", "--abbrev-ref", "HEAD")
    const url = remote.replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/")
    const name = url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "")
    let note = ""
    try {
      const ahead = Number(git("rev-list", "--count", `origin/${branch}..HEAD`))
      const dirty = git("status", "--porcelain").length > 0
      const unpushed = [ahead > 0 ? `${ahead} unpushed commit${ahead === 1 ? "" : "s"}` : "", dirty ? "uncommitted changes" : ""]
        .filter(Boolean).join(" and ")
      if (unpushed) note = `the cloud session works from origin; ${unpushed} are not there`
    } catch {
      note = `branch ${branch} is not on origin; push it first`
    }
    return { url, branch, label: `${name}@${branch}`, note }
  } catch {
    return undefined
  }
}

const cloudSession = Effect.gen(function*() {
  const client = yield* PiCloud
  const model = yield* defaultModel
  const origin = gitOrigin()
  if (origin?.note) write(`Note: ${origin.note}.\n`)
  const create = (home: { readonly repository?: string; readonly ref?: string }) =>
    client.sessions.create({
      payload: {
        title: flags.title ?? origin?.label,
        spec: {
          model,
          sandbox: "home",
          sandboxes: { home },
          ...(origin === undefined ? {} : { metadata: { origin: { url: origin.url, branch: origin.branch } } }),
          ...(flags.instructions === undefined ? {} : { instructions: flags.instructions })
        }
      }
    })
  const session = yield* create(origin === undefined ? {} : { repository: origin.url, ref: origin.branch }).pipe(
    Effect.catchTag("SpecRejected", (error) =>
      origin === undefined || !error.field.startsWith("sandboxes.home.")
        ? Effect.fail(error)
        : Effect.andThen(Effect.sync(() => write(`Note: ${error.message}; the cloud session starts without the repository.\n`)), create({})))
  )
  return { session, label: origin?.label }
})

const resolved = orExit(() => resolveConnection(flags.url, flags["api-key"]))
const connection = { url: resolved.url, apiKey: resolved.apiKey }

const parseModel = (value: string) => {
  const [provider, ...modelId] = value.split("/")
  return { provider: provider!, modelId: modelId.join("/") }
}

const existing = (id: string) => Effect.flatMap(PiCloud, (client) => client.sessions.get({ params: { id: id as never } }))

const converse = (sessionId: string, lines: AsyncIterable<string>, options: { readonly history: boolean }) =>
  Effect.gen(function*() {
    yield* existing(sessionId)
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
      if (flags.resume !== undefined) target = { id: (yield* existing(flags.resume)).id }
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
      const attempt = (run: () => Promise<void>) => Effect.promise(() => run().catch(fail))
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
      yield* existing(rest[0])
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
      process.exitCode = 1
      return write(`${usage}\n`)
  }
})

const explain = (error: unknown) => {
  const failure = error as { _tag?: string; message?: string; reason?: { _tag?: string } } | undefined
  if (failure?._tag === "Unauthorized") return rejected(connection.url)
  if (failure?.reason?._tag === "TransportError" || failure?.reason?._tag === "SocketOpenError") return unreachable(connection.url)
  return failure?.message || failure?._tag || String(error)
}

program.pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause)
      : Effect.sync(() => {
        process.exitCode = 1
        write(`${explain(Cause.squash(cause))}\n`)
      })
  ),
  Effect.provide(PiCloud.layer(connection)),
  NodeRuntime.runMain
)
