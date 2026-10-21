import { describe, expect, it } from "vitest"
import { APP_EVENTS, appManifest } from "../src/index.ts"
import { createApp } from "../src/node.ts"

describe("GitHub App manifest", () => {
  it("asks for what pi-cloud uses, with the trigger's webhook", () => {
    expect(appManifest({ publicUrl: "https://pi.example.com/", redirectUrl: "http://127.0.0.1:1/callback" })).toEqual({
      name: "pi-cloud",
      description: expect.any(String),
      url: "https://pi.example.com",
      redirect_url: "http://127.0.0.1:1/callback",
      public: false,
      default_permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
      hook_attributes: { url: "https://pi.example.com/v1/triggers/github", active: true },
      default_events: [...APP_EVENTS]
    })
    // Without a public URL: tokens only, no webhook.
    const tokensOnly = appManifest({ name: "pi-acme", redirectUrl: "http://127.0.0.1:1/callback" })
    expect(tokensOnly.name).toBe("pi-acme")
    expect(tokensOnly).not.toHaveProperty("hook_attributes")
    expect(tokensOnly).not.toHaveProperty("default_events")
  })

  it("creates the App through GitHub's manifest flow and returns its credentials", async () => {
    const conversions: Array<string> = []
    const fetch = (async (input: string, init: RequestInit) => {
      if (input.startsWith("http://127.0.0.1")) return globalThis.fetch(input, init)
      conversions.push(`${init.method} ${input}`)
      return Response.json({ id: 77, slug: "pi-acme", html_url: "https://github.com/apps/pi-acme", pem: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n", webhook_secret: "whsec" }, { status: 201 })
    }) as typeof globalThis.fetch

    let opened = ""
    const created = createApp({ org: "acme", name: "pi-acme", publicUrl: "https://pi.example.com", fetch, open: (url) => (opened = url) })
    while (opened === "") await new Promise((resolve) => setTimeout(resolve, 10))

    // The browser loads the local page, which posts the manifest to GitHub...
    const html = await (await globalThis.fetch(opened)).text()
    const action = html.match(/action="([^"]+)"/)![1]!.replaceAll("&amp;", "&")
    expect(action).toMatch(/^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=[0-9a-f]{32}$/)
    const manifest = JSON.parse(html.match(/name="manifest" value="([^"]+)"/)![1]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&"))
    expect(manifest.redirect_url).toBe(`${opened}/callback`)
    expect(manifest.hook_attributes.url).toBe("https://pi.example.com/v1/triggers/github")

    // ...and GitHub sends it back with a code; a redirect with another state is refused.
    const state = new URL(action).searchParams.get("state")!
    expect((await globalThis.fetch(`${opened}/callback?code=forged&state=other`)).status).toBe(400)
    const done = await globalThis.fetch(`${opened}/callback?code=c0de&state=${state}`)
    expect(done.status).toBe(200)
    expect(await created).toEqual({
      id: 77,
      slug: "pi-acme",
      htmlUrl: "https://github.com/apps/pi-acme",
      privateKey: expect.stringContaining("BEGIN RSA PRIVATE KEY"),
      webhookSecret: "whsec"
    })
    expect(conversions).toEqual(["POST https://api.github.com/app-manifests/c0de/conversions"])
  })
})
