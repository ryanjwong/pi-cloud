import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { entryText, PiCloud } from "@pi-cloud/client"
import { definePlugin, extensions, modelProviders } from "@pi-cloud/runner"
import { sandboxes } from "@pi-cloud/sandbox"
import { localSandboxes } from "@pi-cloud/sandbox-local"
import { githubTools } from "@pi-cloud/tool-github"
import { githubTrigger } from "@pi-cloud/trigger-github"
import { hmacSha256Hex, triggers } from "@pi-cloud/triggers"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

let deployment: LocalDeployment | undefined
let api: Server | undefined
let root: string | undefined

afterEach(async () => {
  await deployment?.stop()
  await new Promise((resolve) => api === undefined ? resolve(undefined) : api.close(resolve))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  deployment = undefined
  api = undefined
  root = undefined
})

const toolUse = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" })

type Received = { method: string; path: string; authorization: string | undefined; body: any }

const fakeGithub = async () => {
  const received: Array<Received> = []
  api = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      received.push({ method: request.method!, path: request.url!, authorization: request.headers.authorization, body: JSON.parse(body) })
      response.writeHead(201, { "content-type": "application/json" })
      response.end(JSON.stringify({ html_url: `https://github.com${request.url}/1` }))
    })
  })
  await new Promise<void>((resolve) => api!.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, received }
}

const waitFor = async <A>(check: () => Promise<A | undefined>): Promise<A> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await check()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("timed out")
}

describe("GitHub tools", () => {
  it("lets a GitHub-triggered session reply on its thread and open a pull request", async () => {
    const github = await fakeGithub()
    const secret = "webhook-secret"
    const faux = fauxProvider()
    let prompt = ""
    faux.setResponses([
      (context) => {
        prompt = JSON.stringify(context)
        return toolUse("github_comment", { body: "Looking into it" })
      },
      toolUse("github_comment", { body: "Elsewhere", repository: "other/repo", number: 1 }),
      toolUse("github_open_pull_request", { head: "pi/fix", base: "main", title: "Fix the flake" }),
      fauxAssistantMessage("Done")
    ])
    deployment = await startLocal({
      runner: {
        idleMs: 5_000,
        secrets: async (name) => (name === "GITHUB_TOKEN" ? "ghs_test" : undefined),
        plugins: [modelProviders(faux.provider), githubTools({ apiUrl: github.url })]
      },
      extensions: [triggers([githubTrigger({ secret, spec: { model: { provider: "faux", modelId: "faux-1" } } })])]
    })

    const body = JSON.stringify({
      action: "created",
      repository: { full_name: "acme/api" },
      sender: { login: "octocat", type: "User" },
      issue: { number: 7, title: "Flaky test", html_url: "https://github.com/acme/api/issues/7" },
      comment: { body: "@pi please fix", html_url: "https://github.com/acme/api/issues/7#c1", author_association: "MEMBER" }
    })
    const response = await fetch(`${deployment.url}/v1/triggers/github`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": "d1",
        "x-hub-signature-256": `sha256=${await hmacSha256Hex(secret, body)}`
      }
    })
    expect(response.status).toBe(202)

    await waitFor(async () => (github.received.length === 2 ? true : undefined))
    expect(github.received).toEqual([
      { method: "POST", path: "/repos/acme/api/issues/7/comments", authorization: "Bearer ghs_test", body: { body: "Looking into it" } },
      {
        method: "POST",
        path: "/repos/acme/api/pulls",
        authorization: "Bearer ghs_test",
        body: { head: "pi/fix", base: "main", title: "Fix the flake", body: "" }
      }
    ])
    expect(prompt).toContain("This session is about acme/api#7")
    expect(prompt).not.toContain("ghs_test")
  }, 30_000)

  it("gives untrusted sessions no GitHub token and no write tools", async () => {
    const github = await fakeGithub()
    const faux = fauxProvider()
    let prompt = ""
    const seen: Array<string | undefined> = []
    const issued: Array<string> = []
    faux.setResponses([
      (context) => {
        prompt = JSON.stringify(context)
        return fauxAssistantMessage("Done")
      }
    ])
    const { SessionSecrets } = await import("@pi-cloud/core")
    deployment = await startLocal({
      sessionSecrets: SessionSecrets.issuers(async (_, name) => {
        issued.push(name)
        return { value: "ghs_app" }
      }),
      runner: {
        idleMs: 5_000,
        secrets: async (name) => (name === "GITHUB_TOKEN" ? "ghs_test" : undefined),
        plugins: [
          modelProviders(faux.provider),
          githubTools({ apiUrl: github.url }),
          definePlugin({ name: "probe", setup: async ({ secrets }) => (seen.push(await secrets("GITHUB_TOKEN")), {}) })
        ]
      },
      extensions: [triggers([githubTrigger({ secret: "s", spec: { model: { provider: "faux", modelId: "faux-1" } } })])]
    })
    const body = JSON.stringify({
      action: "created",
      repository: { full_name: "acme/api" },
      sender: { login: "octocat", type: "User" },
      issue: { number: 8, title: "Fix", html_url: "https://github.com/acme/api/pull/8", pull_request: {} },
      comment: { body: "Go", html_url: "https://github.com/acme/api/pull/8#c1", author_association: "OWNER" }
    })
    const response = await fetch(`${deployment.url}/v1/triggers/github`, {
      method: "POST",
      body,
      headers: { "x-github-event": "issue_comment", "x-hub-signature-256": `sha256=${await hmacSha256Hex("s", body)}` }
    })
    expect(response.status).toBe(202)

    await waitFor(async () => (prompt === "" ? undefined : true))
    expect(seen).toEqual([undefined])
    expect(issued).toEqual([])
    expect(prompt).not.toContain("github_comment")
    expect(prompt).not.toContain("github_open_pull_request")
    expect(github.received).toEqual([])
  }, 30_000)
})

describe("repository sandboxes", () => {
  it("clones the repository and authenticates git without exposing the token", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-cloud-repo-"))
    const origin = join(root, "origin")
    const git = (cwd: string, ...args: Array<string>) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" })
    execFileSync("git", ["init", "--quiet", "-b", "main", origin])
    await writeFile(join(origin, "README.md"), "from the repository\n")
    git(origin, "add", ".")
    git(origin, "commit", "--quiet", "-m", "init")
    git(origin, "branch", "feature")

    const faux = fauxProvider()
    let prompt = ""
    faux.setResponses([
      (context) => {
        prompt = JSON.stringify(context)
        return toolUse("sandbox_create", { template: "api" })
      },
      toolUse("bash", {
        command: "git branch --show-current && cat README.md && printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill"
      }),
      fauxAssistantMessage("Done")
    ])
    deployment = await startLocal({
      runner: {
        idleMs: 5_000,
        secrets: async (name) => (name === "GITHUB_TOKEN" ? "ghs_sandbox_token" : undefined),
        plugins: [
          modelProviders(faux.provider),
          extensions("coding", CodingTools),
          sandboxes({ providers: [localSandboxes({ root: join(root, "sandboxes") })] })
        ]
      },
      settings: {
        templates: { api: { provider: "local", repository: { url: `file://${origin}`, ref: "feature" }, credential: "GITHUB_TOKEN" } }
      }
    })

    await Effect.runPromise(Effect.gen(function*() {
      const client = yield* PiCloud
      const session = yield* client.sessions.create({
        payload: { spec: { model: { provider: "faux", modelId: "faux-1" }, sandbox: "api" } }
      })
      yield* client.sessions.submit({ params: { id: session.id }, payload: { content: "Go" } })
      const entries = yield* Effect.promise(() =>
        waitFor(async () => {
          const { entries } = await Effect.runPromise(
            client.sessions.entries({ params: { id: session.id }, query: { limit: 1000 } })
          )
          return entries.some((entry: any) => entry.kind === "pi.assistant" && entryText(entry) === "Done") ? entries : undefined
        })
      )
      const results = entries.filter((entry: any) => entry.kind === "pi.tool-result").map((entry) => entryText(entry as never))

      expect(prompt).toContain(`run in this session's \\"api\\" sandbox, which is set up for you`)
      expect(results[0]).toContain("ready and active")
      expect(results[1]).toContain("feature")
      expect(results[1]).toContain("from the repository")
      expect(results[1]).toContain("username=x-access-token")
      expect(results[1]).toContain("password=[secret:GITHUB_TOKEN]")
      expect(JSON.stringify(entries)).not.toContain("ghs_sandbox_token")

      const config = yield* Effect.promise(() => readFile(join(root!, "sandboxes", `${session.id}_api`, ".git", "config"), "utf8"))
      expect(config).not.toContain("ghs_sandbox_token")
      expect(config).not.toContain("credential")
    }).pipe(Effect.provide(PiCloud.layer(deployment!))))
  }, 30_000)
})

describe("GitHub App", () => {
  it("gives a session hour-long tokens for its own repository, refreshed for tools and sandboxes, never seen by the model", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-cloud-app-"))
    const origin = join(root, "origin")
    execFileSync("git", ["init", "--quiet", "-b", "main", origin])
    await writeFile(join(origin, "README.md"), "hello\n")
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: origin })
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init"], { cwd: origin })

    const issued: Array<{ token: string; repositories: Array<string> }> = []
    const comments: Array<string | undefined> = []
    api = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        const reply = (status: number, value: unknown) => {
          response.writeHead(status, { "content-type": "application/json" })
          response.end(JSON.stringify(value))
        }
        if (request.url === "/repos/acme/api/installation") return reply(200, { id: 9 })
        if (request.url === "/app/installations/9/access_tokens") {
          const token = `ghs_app_${issued.length + 1}`
          issued.push({ token, repositories: JSON.parse(body).repositories })
          return reply(201, { token, expires_at: new Date(Date.now() + 60_000).toISOString() })
        }
        if (request.url === "/repos/acme/api/issues/7/comments") {
          comments.push(request.headers.authorization)
          return reply(201, { html_url: "https://github.com/acme/api/issues/7#c2" })
        }
        reply(404, { message: "Not Found" })
      })
    })
    await new Promise<void>((resolve) => api!.listen(0, "127.0.0.1", resolve))
    const githubUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
    const { privateKey } = (await import("node:crypto")).generateKeyPairSync("rsa", { modulusLength: 2048 })
    const { githubApp, githubAppTokens } = await import("@pi-cloud/github-app")
    const { SessionSecrets } = await import("@pi-cloud/core")

    const faux = fauxProvider()
    let prompts = ""
    const reversed = "printf %s \"$GITHUB_TOKEN\" | rev; echo; printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill"
    faux.setResponses([
      (context) => {
        prompts += JSON.stringify(context)
        return toolUse("github_comment", { body: "On it" })
      },
      toolUse("bash", { command: reversed }),
      toolUse("bash", { command: reversed }),
      (context) => {
        prompts += JSON.stringify(context)
        return fauxAssistantMessage("Done")
      }
    ])
    deployment = await startLocal({
      sessionSecrets: SessionSecrets.issuers(githubAppTokens(githubApp({
        appId: "1",
        privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
        apiUrl: githubUrl
      }))),
      runner: {
        idleMs: 5_000,
        plugins: [
          modelProviders(faux.provider),
          extensions("coding", CodingTools),
          githubTools({ apiUrl: githubUrl }),
          sandboxes({ providers: [localSandboxes({ root: join(root, "sandboxes") })] })
        ]
      },
      settings: { templates: { repo: { provider: "local", repository: { url: `file://${origin}` }, credential: "GITHUB_TOKEN" } } },
      extensions: [triggers([githubTrigger({ secret: "s", spec: { model: { provider: "faux", modelId: "faux-1" }, sandbox: "repo" } })])]
    })
    const body = JSON.stringify({
      action: "created",
      repository: { full_name: "acme/api" },
      sender: { login: "octocat", type: "User" },
      issue: { number: 7, title: "Flaky test", html_url: "https://github.com/acme/api/issues/7" },
      comment: { body: "Go", html_url: "https://github.com/acme/api/issues/7#c1", author_association: "OWNER" }
    })
    const delivered = await fetch(`${deployment.url}/v1/triggers/github`, {
      method: "POST",
      body,
      headers: { "x-github-event": "issue_comment", "x-hub-signature-256": `sha256=${await hmacSha256Hex("s", body)}` }
    })
    const session = { id: ((await delivered.json()) as { sessions: Array<never> }).sessions[0]! }

    await Effect.runPromise(Effect.gen(function*() {
      const client = yield* PiCloud
      const entries = yield* Effect.promise(() =>
        waitFor(async () => {
          const { entries } = await Effect.runPromise(client.sessions.entries({ params: { id: session.id }, query: { limit: 1000 } }))
          return entries.some((entry: any) => entry.kind === "pi.assistant" && entryText(entry) === "Done") ? entries : undefined
        })
      )
      const results = entries.filter((entry: any) => entry.kind === "pi.tool-result").map((entry) => entryText(entry as never))

      expect(issued.length).toBeGreaterThanOrEqual(3)
      expect(issued.every((token) => JSON.stringify(token.repositories) === '["api"]')).toBe(true)
      expect(comments).toHaveLength(1)
      expect(issued.map((token) => `Bearer ${token.token}`)).toContain(comments[0])
      const seen = results.slice(1).map((result) => result.split("\n")[0]!.split("").reverse().join(""))
      expect(seen[0]).toMatch(/^ghs_app_\d+$/)
      expect(seen[1]).toMatch(/^ghs_app_\d+$/)
      expect(seen[0]).not.toBe(seen[1])
      expect(results[1]).toContain("password=[secret:GITHUB_TOKEN]")
      for (const { token } of issued) {
        expect(JSON.stringify(entries)).not.toContain(token)
        expect(prompts).not.toContain(token)
      }
    }).pipe(Effect.provide(PiCloud.layer(deployment!))))
  }, 30_000)
})
