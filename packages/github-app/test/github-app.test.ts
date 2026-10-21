import type { Session } from "@pi-cloud/protocol"
import { generateKeyPairSync, verify } from "node:crypto"
import { describe, expect, it } from "vitest"
import { githubApp, githubAppTokens, sessionRepositories } from "../src/index.ts"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
// GitHub hands out PKCS#1 keys; secrets stores often hold them on one line.
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString()
const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString()

type Call = { method: string; path: string; body: any; claims: any }

/** A stand-in for GitHub's App endpoints that checks every JWT against the App's public key. */
const fakeGithub = (options: { expiresInMs?: number } = {}) => {
  const calls: Array<Call> = []
  let minted = 0
  const fetch = (async (input: string, init: RequestInit) => {
    const url = new URL(input)
    const jwt = String((init.headers as Record<string, string>).authorization).replace("Bearer ", "")
    const [header, payload, signature] = jwt.split(".")
    const valid = verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url"))
    if (!valid) return new Response(JSON.stringify({ message: "bad JWT" }), { status: 401 })
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString())
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body))
    calls.push({ method: init.method!, path: url.pathname, body, claims })
    const installation = url.pathname.match(/^\/repos\/([^/]+)\/[^/]+\/installation$/)
    if (installation !== null) {
      return installation[1] === "acme" ? Response.json({ id: 42 }) : Response.json({ message: "Not Found" }, { status: 404 })
    }
    if (url.pathname === "/app/installations/42/access_tokens") {
      minted++
      return Response.json(
        { token: `ghs_${minted}`, expires_at: new Date(Date.now() + (options.expiresInMs ?? 3_600_000)).toISOString() },
        { status: 201 }
      )
    }
    return Response.json({ message: "Not Found" }, { status: 404 })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const session = (spec: Partial<Session["spec"]>): Session => ({ id: "s1", createdAt: 0, spec, runner: { state: "idle" } } as never)

describe("GitHub App tokens", () => {
  it("signs its JWT with the App's key and mints tokens limited to the session's repositories", async () => {
    const github = fakeGithub()
    const app = githubApp({ appId: "123", privateKey: pkcs1.replace(/\n/g, "\\n"), fetch: github.fetch })
    const token = await app.installationToken(["acme/API", "acme/web"])
    expect(token.token).toBe("ghs_1")
    expect(token.expiresAt).toBeGreaterThan(Date.now() + 3_000_000)

    expect(github.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /repos/acme/api/installation",
      "POST /app/installations/42/access_tokens"
    ])
    expect(github.calls[1]!.body).toEqual({
      repositories: ["api", "web"],
      permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" }
    })
    const { claims } = github.calls[0]!
    expect(claims.iss).toBe("123")
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)

    // Reused while it has time left; repositories are compared without case or order.
    expect((await app.installationToken(["acme/web", "ACME/api"])).token).toBe("ghs_1")
    expect(github.calls).toHaveLength(2)
  })

  it("mints again near expiry, accepts PKCS#8 keys, and refuses tokens across accounts", async () => {
    const github = fakeGithub({ expiresInMs: 4 * 60_000 })
    const app = githubApp({ appId: "123", privateKey: pkcs8, fetch: github.fetch, permissions: { contents: "read" } })
    expect((await app.installationToken(["acme/api"])).token).toBe("ghs_1")
    expect((await app.installationToken(["acme/api"])).token).toBe("ghs_2")
    // The installation is looked up once.
    expect(github.calls.filter((call) => call.method === "GET")).toHaveLength(1)
    expect(github.calls[1]!.body.permissions).toEqual({ contents: "read" })

    await expect(app.installationToken(["acme/api", "other/api"])).rejects.toThrow(/one account/)
    await expect(app.installationToken(["other/api"])).rejects.toThrow(/GitHub 404/)
    expect(() => githubApp({ appId: "1", privateKey: "not a key" })).toThrow(/not a PEM/)
  })

  it("issues GITHUB_TOKEN only to sessions about a repository, for that repository's account", async () => {
    const github = fakeGithub()
    const issue = githubAppTokens(githubApp({ appId: "123", privateKey: pkcs1, fetch: github.fetch }))
    const triggered = session({
      metadata: { github: { repository: "acme/api", number: 7 } },
      sandboxes: {
        repo: { provider: "local", repository: { url: "https://github.com/acme/api.git", credential: "GITHUB_TOKEN" } },
        docs: { provider: "local", repository: { url: "git@github.com:acme/docs.git" } },
        elsewhere: { provider: "local", repository: { url: "https://github.com/other/thing" } },
        private: { provider: "local", repository: { url: "https://gitlab.com/acme/api.git" } }
      }
    })
    expect(sessionRepositories(triggered)).toEqual(["acme/api", "acme/docs", "other/thing"])

    expect(await issue(triggered, "GITHUB_TOKEN")).toEqual({ value: "ghs_1", expiresAt: expect.any(Number) })
    expect(github.calls.at(-1)!.body.repositories).toEqual(["api", "docs"])
    expect(await issue(triggered, "OPENAI_API_KEY")).toBeUndefined()
    expect(await issue(session({}), "GITHUB_TOKEN")).toBeUndefined()
  })
})
