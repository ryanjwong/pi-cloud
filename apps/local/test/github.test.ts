import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { entryText, PiCloud } from "@pi-cloud/client"
import { modelProviders } from "@pi-cloud/runner"
import { githubTrigger } from "@pi-cloud/trigger-github"
import { hmacSha256Hex, triggers } from "@pi-cloud/triggers"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

let deployment: LocalDeployment | undefined
afterEach(async () => {
  await deployment?.stop()
  deployment = undefined
})

const secret = "github-webhook-secret"

const comment = (body: string) => ({
  action: "created",
  repository: { full_name: "acme/api" },
  sender: { login: "octocat", type: "User" },
  issue: { number: 7, title: "Fix the flaky test", html_url: "https://github.com/acme/api/pull/7", pull_request: {} },
  comment: { body, html_url: "https://github.com/acme/api/pull/7#issuecomment-1" }
})

describe("GitHub trigger", () => {
  it("routes signed webhooks to the session of their pull request", async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage("On it"), fauxAssistantMessage("Done")])
    deployment = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      runner: { plugins: [modelProviders(faux.provider)], idleMs: 5_000 },
      extensions: [
        triggers([githubTrigger({ secret, mention: "@pi", spec: { model: { provider: "faux", modelId: "faux-1" } } })])
      ]
    })
    const url = `${deployment.url}/v1/triggers/github`

    const deliver = async (payload: unknown, delivery: string, signWith = secret) => {
      const body = JSON.stringify(payload)
      const response = await fetch(url, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": "issue_comment",
          "x-github-delivery": delivery,
          "x-hub-signature-256": `sha256=${await hmacSha256Hex(signWith, body)}`
        }
      })
      return { status: response.status, json: response.status === 202 ? await response.json() : undefined }
    }

    expect((await deliver(comment("@pi please look"), "d1", "wrong-secret")).status).toBe(401)
    expect((await deliver(comment("no mention here"), "d0")).json).toEqual({ accepted: 0, sessions: [] })

    const first = await deliver(comment("@pi why is CI red?"), "d1")
    expect(first.json.accepted).toBe(1)
    const sessionId: string = first.json.sessions[0]

    const userTexts = (entries: ReadonlyArray<unknown>) =>
      entries.filter((entry: any) => entry.kind === "pi.user").map((entry) => entryText(entry as never))

    await Effect.runPromise(Effect.gen(function*() {
      const client = yield* PiCloud
      const transcript = () => client.sessions.entries({ params: { id: sessionId as never }, query: {} })
      const until = Effect.fnUntraced(function*(done: (entries: ReadonlyArray<unknown>) => boolean) {
        for (let attempt = 0; attempt < 200; attempt++) {
          const { entries } = yield* transcript()
          if (done(entries)) return entries
          yield* Effect.sleep(50)
        }
        return yield* Effect.die("timed out")
      })
      const afterFirst = yield* until((entries) => entries.some((entry: any) => entry.kind === "pi.assistant"))
      expect(userTexts(afterFirst)[0]).toContain("Comment on pull request #7 by @octocat")
      expect(userTexts(afterFirst)[0]).toContain("why is CI red?")

      // Another comment on the same pull request reaches the same session; a redelivery is not submitted twice.
      const second = yield* Effect.promise(() => deliver(comment("@pi it's the retry logic"), "d2"))
      expect(second.json.sessions).toEqual([sessionId])
      yield* Effect.promise(() => deliver(comment("@pi it's the retry logic"), "d2"))
      const afterSecond = yield* until((entries) => entries.filter((entry: any) => entry.kind === "pi.assistant").length === 2)
      yield* Effect.sleep(300)
      const { entries } = yield* transcript()
      expect(userTexts(entries)).toHaveLength(2)
      expect(afterSecond.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(PiCloud.layer({ url: deployment.url }))))
  }, 30_000)
})
