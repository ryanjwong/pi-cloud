import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { modelProviders } from "@pi-cloud/runner"
import { slackSource } from "@pi-cloud/source-slack"
import { sources } from "@pi-cloud/sources"
import { hmacSha256Hex } from "@pi-cloud/triggers"
import { createServer, type Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

let deployment: LocalDeployment | undefined
let slackApi: Server | undefined
afterEach(async () => {
  await deployment?.stop()
  slackApi?.close()
  deployment = undefined
})

const signingSecret = "slack-signing-secret"

/** A stand-in for slack.com/api that records posted messages. */
const fakeSlack = (port: number) =>
  new Promise<{ server: Server; posts: Array<{ channel: string; thread_ts: string; text: string; auth?: string }> }>(
    (resolve) => {
      const posts: Array<{ channel: string; thread_ts: string; text: string; auth?: string }> = []
      const server = createServer((req, res) => {
        let body = ""
        req.on("data", (chunk) => (body += chunk))
        req.on("end", () => {
          if (req.url === "/api/chat.postMessage") posts.push({ ...JSON.parse(body), auth: req.headers.authorization })
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
        })
      })
      server.listen(port, "127.0.0.1", () => resolve({ server, posts }))
    }
  )

const until = async (check: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe("Slack source", () => {
  it("turns mentions and thread replies into prompts and answers in the thread", async () => {
    const base = 41_000 + Math.floor(Math.random() * 10_000)
    const slack = await fakeSlack(base + 1)
    slackApi = slack.server
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage("Hi from pi"), fauxAssistantMessage("Still here")])
    deployment = await startLocal({
      port: base,
      runner: { plugins: [modelProviders(faux.provider)], idleMs: 5_000 },
      extensions: [
        sources([
          slackSource({
            signingSecret,
            botToken: "xoxb-test",
            apiUrl: `http://127.0.0.1:${base + 1}/api`,
            spec: { model: { provider: "faux", modelId: "faux-1" } }
          })
        ])
      ]
    })
    const url = `${deployment.url}/v1/sources/slack`

    const send = async (payload: unknown, secret = signingSecret) => {
      const body = JSON.stringify(payload)
      const timestamp = String(Math.floor(Date.now() / 1000))
      const response = await fetch(url, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": `v0=${await hmacSha256Hex(secret, `v0:${timestamp}:${body}`)}`
        }
      })
      return { status: response.status, json: await response.json().catch(() => undefined) }
    }
    const event = (id: string, event: Record<string, unknown>) => ({
      type: "event_callback",
      team_id: "T1",
      event_id: id,
      event: { channel: "C1", user: "U42", ...event }
    })

    expect((await send({ type: "url_verification", challenge: "abc" })).json).toEqual({ challenge: "abc" })
    expect((await send(event("E0", { type: "app_mention", text: "hi", ts: "1.0" }), "wrong")).status).toBe(401)

    // A mention starts a thread session; the answer is posted into that thread.
    await send(event("E1", { type: "app_mention", text: "<@UBOT> hello there", ts: "100.1" }))
    await until(() => slack.posts.length === 1)
    expect(slack.posts[0]).toEqual({ channel: "C1", thread_ts: "100.1", text: "Hi from pi", auth: "Bearer xoxb-test" })

    // Ignored: the bot's own message, and an unaddressed message in a thread the agent is not part of.
    await send(event("E2", { type: "message", text: "echo", ts: "100.2", thread_ts: "100.1", bot_id: "B1" }))
    await send(event("E3", { type: "message", text: "unrelated", ts: "200.2", thread_ts: "200.1" }))

    // A plain reply in the agent's thread continues the same session.
    await send(event("E4", { type: "message", text: "and another thing", ts: "100.3", thread_ts: "100.1" }))
    await until(() => slack.posts.length === 2)
    expect(slack.posts[1]).toMatchObject({ channel: "C1", thread_ts: "100.1", text: "Still here" })

    // Slack retries the same event; nothing is asked or posted twice.
    await send(event("E4", { type: "message", text: "and another thing", ts: "100.3", thread_ts: "100.1" }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(slack.posts).toHaveLength(2)
    expect(faux.state.callCount).toBe(2)
  }, 30_000)
})
