import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { entryText, PiCloud } from "@pi-cloud/client"
import { modelProviders } from "@pi-cloud/runner"
import { slackSource } from "@pi-cloud/source-slack"
import { sources } from "@pi-cloud/sources"
import { sqliteBindings, sqliteSessions, sqliteState } from "@pi-cloud/storage-sqlite"
import { hmacSha256Hex, triggers, webhookTrigger } from "@pi-cloud/triggers"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

let deployment: LocalDeployment | undefined
let slackApi: Server | undefined
let dir: string | undefined
afterEach(async () => {
  await deployment?.stop()
  slackApi?.close()
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  deployment = undefined
  slackApi = undefined
  dir = undefined
})

const model = { provider: "faux", modelId: "faux-1" }
const port = () => 41_000 + Math.floor(Math.random() * 10_000)

const until = async (check: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

type Post = { channel: string; thread_ts: string; text: string }
const fakeSlack = (listen: number) =>
  new Promise<{ server: Server; posts: Array<Post> }>((resolve) => {
    const posts: Array<Post> = []
    const server = createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        if (req.url === "/api/chat.postMessage") posts.push(JSON.parse(body))
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
      })
    })
    server.listen(listen, "127.0.0.1", () => resolve({ server, posts }))
  })

const slackSender = (url: string, signingSecret: string) => async (payload: unknown) => {
  const body = JSON.stringify(payload)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const response = await fetch(url, {
    method: "POST",
    body,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${await hmacSha256Hex(signingSecret, `v0:${timestamp}:${body}`)}`
    }
  })
  return response.status
}

const slackEvent = (id: string, event: Record<string, unknown>) => ({
  type: "event_callback",
  team_id: "T1",
  event_id: id,
  event: { user: "U42", ...event }
})

describe("generic webhook trigger", () => {
  it("verifies, maps and deduplicates JSON webhooks", async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage("Looking at build 41")])
    const secret = "ci-secret"
    deployment = await startLocal({
      port: port(),
      runner: { plugins: [modelProviders(faux.provider)], idleMs: 5_000 },
      extensions: [
        triggers([
          webhookTrigger({
            name: "ci",
            secret,
            toEvents: (payload: any) =>
              payload.status === "failed"
                ? [{ key: `ci:${payload.pipeline}`, content: `Build ${payload.build} failed`, requestId: payload.id, spec: { model } }]
                : []
          })
        ])
      ]
    })
    const post = async (payload: unknown, signature?: string) => {
      const body = typeof payload === "string" ? payload : JSON.stringify(payload)
      const response = await fetch(`${deployment!.url}/v1/triggers/ci`, {
        method: "POST",
        body,
        headers: { "x-pi-cloud-signature": signature ?? `sha256=${await hmacSha256Hex(secret, body)}` }
      })
      return { status: response.status, json: response.status === 202 ? await response.json() : undefined }
    }

    expect((await post({ status: "failed" }, "sha256=00")).status).toBe(401)
    expect((await post("not json")).status).toBe(400)
    expect((await post({ status: "passed", pipeline: "main", build: 40, id: "b40" })).json).toEqual({ accepted: 0, sessions: [] })
    expect((await fetch(`${deployment.url}/v1/triggers/nope`, { method: "POST", body: "{}" })).status).toBe(404)

    const failed = { status: "failed", pipeline: "main", build: 41, id: "b41" }
    const first = await post(failed)
    expect(first.json.accepted).toBe(1)
    const again = await post(failed)
    expect(again.json.sessions).toEqual(first.json.sessions)

    await Effect.runPromise(Effect.gen(function*() {
      const client = yield* PiCloud
      const id = first.json.sessions[0] as never
      let entries: ReadonlyArray<unknown> = []
      yield* Effect.promise(() =>
        until(async () => {
          entries = (await Effect.runPromise(
            client.sessions.entries({ params: { id }, query: {} }).pipe(Effect.provide(PiCloud.layer({ url: deployment!.url })))
          )).entries
          return entries.some((entry: any) => entry.kind === "pi.assistant")
        })
      )
      yield* Effect.sleep(300)
      const { entries: settled } = yield* client.sessions.entries({ params: { id }, query: {} })
      const prompts = settled.filter((entry: any) => entry.kind === "pi.user").map((entry) => entryText(entry as never))
      expect(prompts).toEqual(["Build 41 failed"])
    }).pipe(Effect.provide(PiCloud.layer({ url: deployment.url }))))
  }, 30_000)
})

describe("Slack source", () => {
  it("answers direct messages", async () => {
    const base = port()
    const slack = await fakeSlack(base + 1)
    slackApi = slack.server
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage("Hello in private")])
    deployment = await startLocal({
      port: base,
      runner: { plugins: [modelProviders(faux.provider)], idleMs: 5_000 },
      extensions: [sources([slackSource({ signingSecret: "s", botToken: "t", apiUrl: `http://127.0.0.1:${base + 1}/api`, spec: { model } })])]
    })
    const send = slackSender(`${deployment.url}/v1/sources/slack`, "s")
    // An ordinary channel message without a mention is ignored; a direct message is answered.
    await send(slackEvent("E1", { type: "message", channel: "C9", channel_type: "channel", text: "hey all", ts: "5.0" }))
    await send(slackEvent("E2", { type: "message", channel: "D1", channel_type: "im", text: "hi pi", ts: "10.0" }))
    await until(() => slack.posts.length === 1)
    expect(slack.posts[0]).toEqual({ channel: "D1", thread_ts: "10.0", text: "Hello in private" })
    expect(faux.state.callCount).toBe(1)
  }, 30_000)

  it("keeps threads and delivered replies across a control plane restart", async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-cloud-connectors-"))
    const base = port()
    const slack = await fakeSlack(base + 1)
    slackApi = slack.server
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage("First answer"), fauxAssistantMessage("Second answer")])
    const start = () =>
      startLocal({
        port: base,
        sessions: sqliteSessions({ file: join(dir!, "sessions.sqlite") }),
        state: sqliteState({ directory: join(dir!, "state") }),
        bindings: sqliteBindings({ file: join(dir!, "sessions.sqlite") }),
        runner: { plugins: [modelProviders(faux.provider)], idleMs: 300 },
        extensions: [sources([slackSource({ signingSecret: "s", botToken: "t", apiUrl: `http://127.0.0.1:${base + 1}/api`, spec: { model } })])]
      })

    deployment = await start()
    let send = slackSender(`${deployment.url}/v1/sources/slack`, "s")
    await send(slackEvent("E1", { type: "app_mention", channel: "C1", text: "<@UBOT> question", ts: "100.1" }))
    await until(() => slack.posts.length === 1)
    await deployment.stop()

    deployment = await start()
    send = slackSender(`${deployment.url}/v1/sources/slack`, "s")
    // No mention: this only reaches the agent because the thread's binding survived the restart.
    await send(slackEvent("E2", { type: "message", channel: "C1", text: "follow-up", ts: "100.2", thread_ts: "100.1" }))
    await until(() => slack.posts.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 500))
    // The first answer is in the session's snapshot again after the restart, but it is not posted twice.
    expect(slack.posts.map((post) => post.text)).toEqual(["First answer", "Second answer"])
    expect(slack.posts.every((post) => post.thread_ts === "100.1")).toBe(true)
  }, 30_000)
})
