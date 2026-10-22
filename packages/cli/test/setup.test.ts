import { describe, expect, it } from "vitest"
import { clean, type GithubAppIo, offerGithubApp } from "../src/setup.ts"

describe("clean", () => {
  it("strips bracketed-paste markers and control characters", () => {
    expect(clean("\u001b[200~sk-ant-api03-abc\u001b[201~")).toBe("sk-ant-api03-abc")
    expect(clean(" ghp_x\u0007y\u007f \t")).toBe("ghp_xy")
    expect(clean("sk-ant-plain")).toBe("sk-ant-plain")
  })
})

describe("deploy and GitHub", () => {
  const io = (tty: boolean, answer = "") => {
    const calls = { asked: [] as Array<string>, created: [] as Array<string>, written: "" }
    const value: GithubAppIo = {
      tty,
      ask: async (question) => (calls.asked.push(question), answer),
      create: async (url) => (calls.created.push(url), { GITHUB_APP_ID: "7", GITHUB_APP_PRIVATE_KEY: "pem" }),
      write: (text) => void (calls.written += text)
    }
    return { calls, value }
  }
  const url = "https://pi.example.workers.dev"

  it("offers to create the App with the Worker's URL once, and only on a terminal", async () => {
    const yes = io(true)
    expect(await offerGithubApp(url, "pi-cloud", {}, yes.value)).toEqual({ GITHUB_APP_ID: "7", GITHUB_APP_PRIVATE_KEY: "pem" })
    expect(yes.calls.created).toEqual([url])

    const no = io(true, "n")
    expect(await offerGithubApp(url, "pi-cloud", {}, no.value)).toEqual({})
    expect(no.calls.written).toContain(`pi-cloud github-app --url ${url} && pi-cloud deploy cloudflare\n`)

    const piped = io(false)
    expect(await offerGithubApp(url, "staging", {}, piped.value)).toEqual({})
    expect(piped.calls.asked).toEqual([])
    expect(piped.calls.written).toContain(`pi-cloud github-app --url ${url} && pi-cloud deploy cloudflare --name staging`)

    const broken = io(true)
    expect(await offerGithubApp(url, "pi-cloud", {}, { ...broken.value, create: () => Promise.reject(new Error("closed")) })).toEqual({})
    expect(broken.calls.written).toContain("GitHub App not created: closed")
    expect(broken.calls.written).toContain(`pi-cloud github-app --url ${url}`)

    const stored = io(true)
    expect(await offerGithubApp(url, "pi-cloud", { GITHUB_APP_ID: "1" }, stored.value)).toEqual({})
    expect([stored.calls.asked, stored.calls.created, stored.calls.written]).toEqual([[], [], ""])
  })
})
