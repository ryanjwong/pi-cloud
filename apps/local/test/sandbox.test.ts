import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { connectServices, entryText, PiCloud } from "@pi-cloud/client"
import { resolveSpec, Sessions } from "@pi-cloud/control-plane"
import { BindingStore, RepositoryAccess, SessionStore } from "@pi-cloud/core"
import { githubApp, installedRepositories, publicRepositories } from "@pi-cloud/github-app"
import { type SandboxTemplate, Session, SessionId, VERSION } from "@pi-cloud/protocol"
import { extensions, modelProviders } from "@pi-cloud/runner"
import { sandboxes } from "@pi-cloud/sandbox"
import { localSandboxes } from "@pi-cloud/sandbox-local"
import { Effect, Layer } from "effect"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

let deployment: LocalDeployment | undefined
let root: string | undefined

afterEach(async () => {
  await deployment?.stop()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  deployment = undefined
})

const toolUse = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" })

describe("sandboxes", () => {
  it("lets the agent request a sandbox from a template and work inside it", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-cloud-sandboxes-"))
    process.env.PI_CLOUD_LEAK_CANARY = "canary-must-not-leak"
    const faux = fauxProvider()
    faux.setResponses([
      toolUse("bash", { command: "pwd" }),
      toolUse("sandbox_create", { template: "repo" }),
      toolUse("bash", { command: "cat README.md && echo $GREETING && printf %s \"$PI_CLOUD_TEST_SECRET\" > secret.txt" }),
      toolUse("bash", { command: "env; echo token=$PI_CLOUD_TEST_SECRET" }),
      fauxAssistantMessage("All done")
    ])
    deployment = await startLocal({
      runner: {
        idleMs: 5_000,
        secrets: async (name) => (name === "PI_CLOUD_TEST_SECRET" ? "s3cret-value" : undefined),
        plugins: [
          modelProviders(faux.provider),
          extensions("coding", CodingTools),
          sandboxes({ providers: [localSandboxes({ root })] })
        ]
      },
      settings: {
        templates: {
          repo: {
            provider: "local",
            setup: ["echo 'project readme' > README.md"],
            env: { GREETING: "hello from the template" },
            secrets: ["PI_CLOUD_TEST_SECRET"]
          }
        }
      }
    })
    const local = deployment

    const program = Effect.gen(function*() {
      const client = yield* PiCloud
      const session = yield* client.sessions.create({
        payload: {
          spec: { model: { provider: "faux", modelId: "faux-1" } }
        }
      })
      const submitted = yield* client.sessions.submit({ params: { id: session.id }, payload: { content: "Go" } })
      while (true) {
        const record = yield* client.sessions.submission({
          params: { id: session.id, submissionId: submitted.submissionId }
        })
        if ((record as { status?: string } | null)?.status === "done") break
        yield* Effect.sleep(100)
      }
      const { entries } = yield* client.sessions.entries({ params: { id: session.id }, query: { limit: 1000 } })
      const results = entries.filter((entry: any) => entry.kind === "pi.tool-result").map((entry) => entryText(entry as never))

      expect(results[0]).toMatch(/environment/i)
      expect(results[1]).toContain("ready and active")
      expect(results[2]).toContain("project readme")
      expect(results[2]).toContain("hello from the template")

      expect(results[3]).toContain("token=[secret:PI_CLOUD_TEST_SECRET]")
      expect(results[3]).toContain("GREETING=hello from the template")
      expect(results[3]).not.toContain("canary-must-not-leak")
      expect(results[3]).not.toContain("ANTHROPIC")

      const secret = yield* Effect.promise(() => readFile(join(root!, `${session.id}_repo`, "secret.txt"), "utf8"))
      expect(secret).toBe("s3cret-value")
      expect(JSON.stringify(entries)).not.toContain("s3cret-value")
    })

    await Effect.runPromise(program.pipe(Effect.provide(PiCloud.layer(local))))
  }, 30_000)

  it("refuses specs that reach past the operator's templates, naming the field, over REST and Chord", async () => {
    deployment = await startLocal({
      runner: { plugins: [] },
      settings: { templates: { box: { provider: "docker", repositories: ["acme/api"], allowRef: true } } }
    })
    const { url, apiKey } = deployment
    const create = async (spec: unknown) => {
      const response = await fetch(`${url}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ spec })
      })
      return { status: response.status, body: await response.text() }
    }
    const refused: ReadonlyArray<readonly [unknown, string]> = [
      [{ sandboxes: { box: { provider: "local" } } }, "provider"],
      [{ sandboxes: { box: { template: "box", options: { network: "host" } } } }, "options"],
      [{ sandboxes: { box: { template: "box", env: { DOCKER_HOST: "tcp://evil:2375" } } } }, "env"],
      [{ plugins: { github: { token: "x" } } }, "plugins"],
      [{ metadata: { github: { repository: "acme/api", number: 1 } } }, "metadata.github"],
      [{ sandboxes: { box: { template: "nope" } } }, "sandboxes.box.template"],
      [{ sandboxes: { box: { template: "box", repository: "https://github.com/other/api" } } }, "sandboxes.box.repository"],
      [{ sandboxes: { box: { template: "box", cwd: "../../etc" } } }, "sandboxes.box.cwd"],
      [{ sandbox: "missing" }, "sandbox"]
    ]
    for (const [spec, field] of refused) {
      const response = await create(spec)
      expect(response.status, JSON.stringify(spec)).toBe(400)
      expect(response.body, JSON.stringify(spec)).toContain(field)
    }
    const allowed = await create({ sandboxes: { box: { template: "box", repository: "git@github.com:Acme/api.git", ref: "dev" } } })
    expect(allowed.status).toBe(200)

    const connection = await connectServices({ url, apiKey })
    try {
      const directory = await connection.sessions()
      await expect(directory.create({ spec: { sandboxes: { box: { provider: "local" } } } })).rejects.toThrow(/provider/)
      await expect(directory.create({ spec: { sandboxes: { box: { template: "nope" } } } })).rejects.toThrow(/sandboxes\.box\.template/)
    } finally {
      await connection.close()
    }
  })

  it("binds the repository on the server and strips secrets from untrusted sessions", async () => {
    const settings = {
      defaultSandbox: "box",
      templates: { box: { provider: "docker", repositories: ["acme/api"], secrets: ["NPM_TOKEN"], credential: "GITHUB_TOKEN" } }
    }
    const spec = { sandbox: "repo", sandboxes: { repo: { repository: "https://github.com/acme/api.git" } } }
    const narrow = (...args: Parameters<typeof resolveSpec>) => resolveSpec(...args).pipe(Effect.provide(RepositoryAccess.none))
    const resolved = await Effect.runPromise(narrow(spec, settings))
    expect(resolved.repository).toBe("acme/api")
    expect(resolved.untrusted).toBeUndefined()
    expect(resolved.sandboxes.repo).toMatchObject({ provider: "docker", repository: { url: "https://github.com/acme/api.git" }, secrets: ["NPM_TOKEN"] })
    const forked = await Effect.runPromise(narrow(spec, settings, { repository: "acme/api", thread: 7, untrusted: true }))
    expect(forked).toMatchObject({ repository: "acme/api", thread: 7, untrusted: true })
    for (const template of Object.values(forked.sandboxes)) {
      expect(template.secrets).toEqual([])
      expect(template.credential).toBeUndefined()
    }
    const other = { sandboxes: { repo: { repository: "https://github.com/other/api" } } }
    expect(await Effect.runPromise(narrow(other, settings, { repository: "other/api" }))).toMatchObject({ repository: "other/api" })
    const refused = await Effect.runPromise(Effect.flip(narrow(other, settings)))
    expect(refused.field).toBe("sandboxes.repo.repository")
  })

  it("clones any repository the GitHub App is installed on, public ones without an App, and still narrows to allowlists", async () => {
    const github = (async (input: string) => {
      const { pathname } = new URL(input)
      if (pathname === "/app") return Response.json({ html_url: "https://github.com/apps/pi-cloud" })
      if (/^\/repos\/acme\/[^/]+\/installation$/.test(pathname)) return Response.json({ id: 42 })
      if (pathname === "/repos/torvalds/linux") return Response.json({ private: false })
      return Response.json({ message: "Not Found" }, { status: 404 })
    }) as unknown as typeof globalThis.fetch
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString()
    const installed = RepositoryAccess.make(installedRepositories(githubApp({ appId: "1", privateKey, fetch: github })))
    const anonymous = RepositoryAccess.make(publicRepositories({ fetch: github }))
    const templates = {
      scratch: { provider: "docker", repositories: "installed", allowRef: true, credential: "GITHUB_TOKEN" },
      narrow: { provider: "docker", repositories: ["acme/api"] }
    } as const
    const spec = (repository: string, template = "scratch") => ({ sandbox: "home", sandboxes: { home: { template, repository, ...(template === "scratch" ? { ref: "dev" } : {}) } } })
    const resolve = (repository: string, access: Layer.Layer<RepositoryAccess>, template?: string, settings: { defaultSandbox: string; templates: Record<string, SandboxTemplate> } = { defaultSandbox: "scratch", templates }) =>
      Effect.runPromise(resolveSpec(spec(repository, template), settings).pipe(Effect.provide(access)))
    const refusal = (...args: Parameters<typeof resolve>) => resolve(...args).then(() => undefined, (error) => error.reason as string)

    expect(await resolve("git@github.com:acme/web.git", installed)).toMatchObject({
      repository: "acme/web",
      sandboxes: { home: { credential: "GITHUB_TOKEN", repository: { url: "git@github.com:acme/web.git", ref: "dev" } } }
    })
    expect(await refusal("https://github.com/other/api", installed)).toBe("install the GitHub App on other/api: https://github.com/apps/pi-cloud/installations/new")
    expect(await refusal("https://gitlab.com/acme/api", installed)).toMatch(/does not allow/)
    expect(await refusal("https://github.com/acme/web", installed, "narrow")).toMatch(/template "narrow" does not allow/)
    expect(await resolve("https://github.com/acme/api", installed, "narrow")).toMatchObject({ repository: "acme/api" })

    const withoutApp = { defaultSandbox: "scratch", templates: { scratch: { provider: "docker", repositories: "installed", allowRef: true } } } as const
    const cloned = await resolve("https://github.com/torvalds/linux", anonymous, undefined, withoutApp)
    expect(cloned.sandboxes.home).toMatchObject({ repository: { url: "https://github.com/torvalds/linux" } })
    expect(cloned.sandboxes.home!.credential).toBeUndefined()
    expect(await refusal("https://github.com/acme/secret", anonymous, undefined, withoutApp)).toMatch(/private or does not exist.*pi-cloud deploy cloudflare/)
    expect(await refusal("https://github.com/acme/api", RepositoryAccess.none, undefined, withoutApp)).toMatch(/no GitHub access configured/)
    for (const dotted of ["https://github.com/../..", "https://github.com/acme/.", "https://github.com/acme/..git", "git@github.com:./api"]) {
      expect(await refusal(dotted, anonymous, undefined, withoutApp)).toMatch(/does not allow/)
    }

    deployment = await startLocal({
      runner: { plugins: [] },
      repositoryAccess: installed,
      settings: { templates }
    })
    const create = (repository: string) =>
      fetch(`${deployment!.url}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${deployment!.apiKey}` },
        body: JSON.stringify({ spec: spec(repository) })
      })
    expect((await create("https://github.com/acme/api")).status).toBe(200)
    const refused = await create("https://github.com/other/api")
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain("install the GitHub App on other/api")
  })

  it("refuses commands to sessions from before spec checks and gives their threads a new session", async () => {
    const legacy = new Session({ id: SessionId.make("ses_legacy"), spec: {}, createdAt: 0 })
    const { store, bindings } = await Effect.runPromise(Effect.gen(function*() {
      const store = yield* SessionStore
      const bindings = yield* BindingStore
      yield* store.put(legacy)
      yield* bindings.put({ key: "github:acme/api#1", sessionId: legacy.id, createdAt: 0 })
      return { store, bindings }
    }).pipe(Effect.provide(Layer.merge(SessionStore.memory, BindingStore.memory))))
    let sessions: Sessions["Service"] | undefined
    deployment = await startLocal({
      runner: { plugins: [] },
      settings: { templates: { box: { provider: "docker" } }, defaultSandbox: "box" },
      sessions: Layer.succeed(SessionStore, store),
      bindings: Layer.succeed(BindingStore, bindings),
      extensions: [Layer.effectDiscard(Effect.map(Sessions, (service) => void (sessions = service)))]
    })
    const submitted = await fetch(`${deployment.url}/v1/sessions/${legacy.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deployment.apiKey}` },
      body: JSON.stringify({ content: "hi" })
    })
    expect(submitted.status).toBe(500)
    expect(await submitted.text()).toContain("predates")
    const { binding, created } = await Effect.runPromise(sessions!.forKey("github:acme/api#1", {}))
    expect(created).toBe(true)
    expect(binding.sessionId).not.toBe(legacy.id)
    expect((await Effect.runPromise(sessions!.forKey("github:acme/api#1", {}))).created).toBe(false)
    const forked = await Effect.runPromise(sessions!.forKey("github:acme/api#1", { untrusted: true }))
    expect(forked.created).toBe(true)
    expect(forked.binding.sessionId).not.toBe(binding.sessionId)
  })

  it("describes the server and its sandbox templates", async () => {
    deployment = await startLocal({
      runner: { plugins: [] },
      settings: { templates: { box: { provider: "docker" } }, defaultSandbox: "box" }
    })
    expect(await (await fetch(`${deployment.url}/v1/server`)).json()).toEqual({ version: VERSION, servicesPath: "/v1/pi" })
    expect(await (await fetch(`${deployment.url}/v1/server/details`, { headers: { authorization: `Bearer ${deployment.apiKey}` } })).json())
      .toMatchObject({ version: VERSION, defaultSandbox: "box", sandboxTemplates: ["box"] })
  })
})
