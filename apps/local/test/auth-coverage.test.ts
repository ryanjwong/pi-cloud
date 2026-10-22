import { HttpApi } from "effect/http-api"
import { PublicApi, RUNNER_RPC_PATH, RunnerRpcs } from "@pi-cloud/protocol"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

const PUBLIC = new Set(["GET /health", "GET /v1/server"])

let deployment: LocalDeployment
beforeAll(async () => {
  deployment = await startLocal({
    port: 41_000 + Math.floor(Math.random() * 10_000),
    apiKeys: ["the-key"],
    runnerSecret: "the-runner-secret",
    runner: { plugins: [] }
  })
})
afterAll(() => deployment.stop())

const endpoints = () => {
  const found: Array<{ method: string; path: string }> = []
  HttpApi.reflect(PublicApi, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => void found.push({ method: endpoint.method, path: endpoint.path })
  })
  return found
}
const fill = (path: string) => path.replace(/:(\w+)/g, (_, name: string) => (/id$/i.test(name) && name !== "id" ? "1" : "ses_0123456789abcdef0123456789abcdef"))

describe("authentication coverage", () => {
  it("refuses every public API endpoint, as the API declares them, without a valid key", async () => {
    const all = endpoints()
    expect(all.length).toBeGreaterThan(15)
    for (const { method, path } of all) {
      if (PUBLIC.has(`${method} ${path}`)) continue
      for (const authorization of [undefined, "Bearer wrong", "Bearer the-runner-secret", "the-key", "Basic dGhlLWtleTo="]) {
        const response = await fetch(`${deployment.url}${fill(path)}`, {
          method,
          headers: { "content-type": "application/json", ...(authorization === undefined ? {} : { authorization }) },
          ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" })
        })
        expect(response.status, `${method} ${path} with ${authorization ?? "no key"}`).toBe(401)
      }
    }
    for (const entry of PUBLIC) expect(all.map(({ method, path }) => `${method} ${path}`)).toContain(entry)
  })

  it("refuses the WebSocket surfaces without a valid key", async () => {
    for (const path of ["/v1/pi", "/v1/sessions/ses_0123456789abcdef0123456789abcdef/channel"]) {
      for (const authorization of [undefined, "Bearer wrong"]) {
        const response = await fetch(`${deployment.url}${path}`, { headers: authorization === undefined ? {} : { authorization } })
        expect(response.status, `${path} with ${authorization ?? "no key"}`).toBe(401)
      }
    }
  })

  it("refuses every runner RPC, as the group declares them, without the runner secret", async () => {
    const tags = [...RunnerRpcs.requests.keys()]
    expect(tags.length).toBeGreaterThan(10)
    const payload = {
      sessionId: "ses_0123456789abcdef0123456789abcdef",
      token: "t",
      runnerId: "r",
      name: "GITHUB_TOKEN",
      providerId: "anthropic",
      version: 0,
      credential: { type: "api_key", key: "k" },
      link: 0,
      frames: [],
      commandId: "c",
      result: { _tag: "Ok" },
      batches: [],
      method: "mintId",
      args: []
    }
    for (const tag of tags) {
      for (const authorization of [undefined, "Bearer wrong", "Bearer the-key"]) {
        const response = await fetch(`${deployment.url}${RUNNER_RPC_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/ndjson", ...(authorization === undefined ? {} : { authorization }) },
          body: `${JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })}\n`
        })
        const body = await response.text()
        expect(body, `${tag} with ${authorization ?? "no secret"}`).toContain("Invalid runner credentials")
        expect(body).not.toMatch(/"_tag":"(Success|Chunk)"/)
      }
    }
  })
})
