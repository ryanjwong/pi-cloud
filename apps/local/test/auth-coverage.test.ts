import { connectServices } from "@pi-cloud/client"
import { sha256 } from "@pi-cloud/control-plane"
import { allows, PublicApi, RUNNER_RPC_PATH, RunnerRpcs, type Scope, webSocketProtocols } from "@pi-cloud/protocol"
import { makeClient } from "@pi-cloud/runner"
import { Effect, Exit, Stream } from "effect"
import { HttpApi } from "effect/http-api"
import { randomBytes } from "node:crypto"
import { type IncomingHttpHeaders, request as httpRequest } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

const PUBLIC = new Set(["GET /health", "GET /v1/server"])
const SESSION = "ses_0123456789abcdef0123456789abcdef"
const KEYS: Record<string, ReadonlyArray<Scope>> = { "none-key": [], "read-key": ["read"], "write-key": ["write"], "a/b+c=": ["read"] }

let deployment: LocalDeployment
beforeAll(async () => {
  deployment = await startLocal({
    port: 41_000 + Math.floor(Math.random() * 10_000),
    apiKey: "the-key",
    runnerSecret: "the-runner-secret",
    auth: { keys: Object.entries(KEYS).map(([token, scopes]) => ({ name: token, sha256: sha256(token), scopes })) },
    runner: { plugins: [] }
  })
})
afterAll(() => deployment.stop())

const endpoints = () => {
  const found: Array<{ group: string; method: string; path: string }> = []
  HttpApi.reflect(PublicApi, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint }) => void found.push({ group: group.identifier, method: endpoint.method, path: endpoint.path })
  })
  return found
}
const fill = (path: string) => path.replace(/:(\w+)/g, (_, name: string) => (/id$/i.test(name) && name !== "id" ? "1" : SESSION))
const scopeOf = (group: string, method: string): Scope => group === "credentials" ? "admin" : method === "GET" ? "read" : "write"

const upgrade = (path: string, token: string | null, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; protocol?: string | undefined }>((resolve, reject) => {
    const request = httpRequest(`${deployment.url}${path}`, {
      agent: false,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-protocol": webSocketProtocols(token ?? undefined).join(", "),
        ...headers
      }
    })
    request.on("upgrade", (response, socket) => {
      socket.destroy()
      resolve({ status: response.statusCode!, protocol: response.headers["sec-websocket-protocol"] })
    })
    request.on("response", (response) => {
      response.resume()
      resolve({ status: response.statusCode! })
    })
    request.on("error", reject)
    request.end()
  })

const get = (url: string, headers: Record<string, string>) =>
  new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) =>
    httpRequest(url, { agent: false, headers }, (response) => {
      response.resume()
      resolve({ status: response.statusCode!, headers: response.headers })
    }).on("error", reject).end()
  )

describe("authentication coverage", () => {
  it("refuses every public API endpoint without a valid key, and with a key lacking the endpoint's scope", async () => {
    const all = endpoints()
    expect(all.length).toBeGreaterThan(15)
    for (const { group, method, path } of all) {
      if (PUBLIC.has(`${method} ${path}`)) continue
      const call = (authorization: string | undefined) =>
        fetch(`${deployment.url}${fill(path)}`, {
          method,
          headers: { "content-type": "application/json", ...(authorization === undefined ? {} : { authorization }) },
          ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" })
        }).then((response) => response.status)
      for (const authorization of [undefined, "Bearer wrong", "Bearer the-runner-secret", "the-key", "Basic dGhlLWtleTo="]) {
        expect(await call(authorization), `${method} ${path} with ${authorization ?? "no key"}`).toBe(401)
      }
      for (const [token, scopes] of Object.entries(KEYS)) {
        const status = await call(`Bearer ${token}`)
        if (allows({ kind: "client", id: "", name: token, scopes }, scopeOf(group, method))) expect(status, `${method} ${path} with ${token}`).not.toBeOneOf([401, 403])
        else expect(status, `${method} ${path} with ${token}`).toBe(403)
      }
    }
    for (const entry of PUBLIC) expect(all.map(({ method, path }) => `${method} ${path}`)).toContain(entry)
  })

  it("refuses the WebSocket surfaces without a valid key, with the wrong scope, from another origin or host, and never reads query tokens", async () => {
    for (const [path, scope] of [["/v1/pi", "read"], [`/v1/sessions/${SESSION}/channel`, "write"]] as const) {
      expect(await upgrade(path, null), path).toEqual({ status: 401 })
      expect(await upgrade(`${path}?token=the-key&access_token=the-key`, null), path).toEqual({ status: 401 })
      expect(await upgrade(path, "wrong"), path).toEqual({ status: 401 })
      expect(await upgrade(path, "none-key"), path).toEqual({ status: 403 })
      if (scope === "write") expect(await upgrade(path, "read-key"), path).toEqual({ status: 403 })
      expect(await upgrade(path, "the-key", { origin: "https://evil.example" }), path).toEqual({ status: 403 })
      expect(await upgrade(path, "the-key", { origin: "null" }), path).toEqual({ status: 403 })
      expect(await upgrade(path, "the-key", { host: `evil.example:${new URL(deployment.url).port}` }), path).toEqual({ status: 403 })
    }
    expect(await upgrade("/v1/pi", "the-key", { host: `localhost:${new URL(deployment.url).port}` })).toEqual({ status: 101, protocol: "pi-cloud.v1" })
    expect(await upgrade("/v1/pi", "a/b+c=")).toEqual({ status: 101, protocol: "pi-cloud.v1" })
    expect((await fetch(`${deployment.url}/health`, { headers: { origin: "https://evil.example" } })).status).toBe(403)
  })

  it("lets configured origins through with CORS headers, and lets auth.allowedHosts replace the loopback names", async () => {
    const custom = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      auth: { allowedOrigins: ["https://app.example"], allowedHosts: ["pi.example", "127.0.0.1"] },
      runner: { plugins: [] }
    })
    try {
      const port = new URL(custom.url).port
      const allowed = await get(`${custom.url}/health`, { origin: "https://app.example", host: `pi.example:${port}` })
      expect(allowed.status).toBeLessThan(300)
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example")
      expect((await get(`${custom.url}/health`, { origin: "https://evil.example", host: `pi.example:${port}` })).status).toBe(403)
      expect((await get(`${custom.url}/health`, { host: `localhost:${port}` })).status).toBe(403)
    } finally {
      await custom.stop()
    }
  })

  it("lets the PUBLIC_URL host through on loopback, so a tunnel in front still works", async () => {
    const tunneled = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      settings: { publicUrl: "https://pi.example.com" },
      runner: { plugins: [] }
    })
    try {
      const port = new URL(tunneled.url).port
      expect((await get(`${tunneled.url}/health`, { host: "pi.example.com" })).status).toBeLessThan(300)
      expect((await get(`${tunneled.url}/health`, { host: `evil.example:${port}` })).status).toBe(403)
    } finally {
      await tunneled.stop()
    }
  })

  it("checks scopes on every Chord operation", async () => {
    for (const apiKey of [undefined, "wrong", "none-key"]) {
      await expect(connectServices({ url: deployment.url, ...(apiKey === undefined ? {} : { apiKey }) }), apiKey).rejects.toThrow(/Cannot connect/)
    }
    const writer = await connectServices({ url: deployment.url, apiKey: "write-key" })
    const reader = await connectServices({ url: deployment.url, apiKey: "a/b+c=" })
    try {
      const created = await (await writer.sessions()).create({})
      const directory = await reader.sessions()
      await expect(directory.create({})).rejects.toThrow(/cannot change/)

      await expect(directory.remove({ id: created.id })).rejects.toThrow(/cannot change/)
      await expect(reader.session(created.id)).rejects.toThrow(/forbidden/)
      await (await writer.sessions()).remove({ id: created.id })
    } finally {
      await reader.close()
      await writer.close()
    }
  })

  it("refuses every runner RPC, as the group declares them, without the runner secret", async () => {
    const tags = [...RunnerRpcs.requests.keys()]
    expect(tags.length).toBeGreaterThan(10)
    const payload = {
      sessionId: SESSION,
      token: "t",
      grant: "g",
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

  it("lets a runner attach only with the session grant from its wake", async () => {
    const created = await fetch(`${deployment.url}/v1/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer the-key", "content-type": "application/json" },
      body: "{}"
    }).then((response) => response.json()) as { id: string }
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const rpc = yield* makeClient({ url: deployment.url, secret: "the-runner-secret" })
      for (const grant of ["", "wrong"]) {
        const exit = yield* Effect.exit(Stream.runHead(rpc.Attach({ sessionId: created.id, runnerId: "r", grant })))
        expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("Unauthorized")
      }
    })))
    const missing = await fetch(`${deployment.url}${RUNNER_RPC_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/ndjson", authorization: "Bearer the-runner-secret" },
      body: `${JSON.stringify({ _tag: "Request", id: "1", tag: "Attach", payload: { sessionId: created.id, runnerId: "r" }, headers: [] })}\n`
    })
    expect(await missing.text()).not.toMatch(/"_tag":"(Success|Chunk)"/)
  })
})
