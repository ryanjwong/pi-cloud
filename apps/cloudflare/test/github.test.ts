import { connectors } from "@pi-cloud/connectors"
import { ControlPlane } from "@pi-cloud/control-plane"
import { RunnerDispatcher } from "@pi-cloud/core"
import { definePlugin, RunnerHost } from "@pi-cloud/runner"
import { createHmac, generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { INTERNAL_URL, settings } from "../src/env.ts"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })

const github = () => {
  const minted: Array<unknown> = []
  const real = globalThis.fetch
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.host !== "api.github.com") return real(input, init)
    if (url.pathname === "/repos/acme/api/installation") return Response.json({ id: 42 })
    if (url.pathname !== "/app/installations/42/access_tokens") return Response.json({ message: "Not Found" }, { status: 404 })
    minted.push(JSON.parse(String(init?.body)).repositories)
    return Response.json({ token: `ghs_${minted.length}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 })
  })
  return minted
}

afterEach(() => vi.unstubAllGlobals())

const until = async <A>(check: () => A | undefined) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = check()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("timed out")
}

describe("GitHub on Cloudflare", () => {
  it("gives sessions an App token for their bound repository, none to untrusted ones, and starts them from webhooks", async () => {
    const minted = github()
    const env = await settings({
      PI_CLOUD_API_KEYS: "key",
      PI_CLOUD_RUNNER_SECRET: "runner",
      PI_CLOUD_CREDENTIAL_KEY: "k".repeat(32),
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      GITHUB_WEBHOOK_SECRET: "hook"
    } as never)
    expect(env.settings.templates.github).toMatchObject({ provider: "daytona", credential: "GITHUB_TOKEN" })

    const seen = new Map<string, string | undefined>()
    let host: RunnerHost | undefined
    const { handler, dispose } = ControlPlane.toWebHandler({
      settings: { ...env.settings, publicUrl: INTERNAL_URL },
      apiKeys: ["key"],
      runnerSecret: "runner",
      ...connectors(env),
      dispatcher: RunnerDispatcher.make((wake) => host!.wake(wake))
    })
    host = new RunnerHost({
      controlPlaneUrl: INTERNAL_URL,
      secret: "runner",
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch,
      plugins: [definePlugin({ name: "probe", setup: async ({ session, secrets }) => (seen.set(session.id, await secrets("GITHUB_TOKEN")), {}) })]
    })

    const deliver = async (event: string, payload: unknown) => {
      const body = JSON.stringify({ repository: { full_name: "acme/api" }, sender: { login: "octocat", type: "User" }, ...payload as object })
      const response = await handler(new Request(`${INTERNAL_URL}/v1/triggers/github`, {
        method: "POST",
        body,
        headers: { "x-github-event": event, "x-hub-signature-256": `sha256=${createHmac("sha256", "hook").update(body).digest("hex")}` }
      }))
      expect(response.status).toBe(202)
      return ((await response.json()) as { sessions: Array<string> }).sessions[0]!
    }

    const trusted = await deliver("issue_comment", {
      action: "created",
      issue: { number: 7, title: "Flaky", html_url: "https://github.com/acme/api/issues/7" },
      comment: { body: "Go", html_url: "https://github.com/acme/api/issues/7#c1", author_association: "OWNER" }
    })
    const forked = await deliver("pull_request", {
      action: "opened",
      pull_request: {
        number: 8,
        title: "Fork",
        html_url: "https://github.com/acme/api/pull/8",
        author_association: "OWNER",
        head: { ref: "x", sha: "0".repeat(40), repo: { full_name: "mallory/api" } },
        base: { ref: "main" }
      }
    })

    expect(await until(() => seen.get(trusted))).toBe("ghs_1")
    await until(() => (seen.has(forked) ? true : undefined))
    expect(seen.get(forked)).toBeUndefined()
    expect(minted).toEqual([["api"]])
    const unsigned = await handler(new Request(`${INTERNAL_URL}/v1/triggers/github`, { method: "POST", body: "{}", headers: { "x-github-event": "ping" } }))
    expect(unsigned.status).toBe(401)
    await dispose()
  }, 30_000)
})
