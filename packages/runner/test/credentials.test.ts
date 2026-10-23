import type { Credential } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { RemoteCredentialStore } from "../src/RemoteCredentials.ts"

const oauth = (access: string): Credential => ({ type: "oauth", access, refresh: `r-${access}`, expires: 0 })

describe("RemoteCredentialStore", () => {
  it("retries a refresh against the token another runner stored first", async () => {
    let stored = { credential: oauth("old") as Credential | undefined, version: 1 }
    let raced = false
    const store = new RemoteCredentialStore({
      get: async () => stored,
      list: async () => [],
      put: async (_id, version, credential) => {
        if (!raced) {
          raced = true
          stored = { credential: oauth("theirs"), version: 2 }
        }
        if (version !== stored.version) return { stored: false, version: stored.version }
        stored = { credential, version: version + 1 }
        return { stored: true, version: stored.version }
      }
    })
    const seen: Array<string> = []
    const result = await store.modify("faux", async (current) => {
      const access = (current as { access: string }).access
      seen.push(access)
      return access === "old" ? oauth("mine") : current
    })
    expect(seen).toEqual(["old", "theirs"])
    expect((result as { access: string }).access).toBe("theirs")
    expect((stored.credential as { access: string }).access).toBe("theirs")
  })

  it("shares one read per credential until it nears expiry, never caching a missing one", async () => {
    const gets: Array<string> = []
    const store = new RemoteCredentialStore({
      get: async (providerId) => {
        gets.push(providerId)
        if (providerId === "none") return { version: 0 }
        return { credential: { ...oauth(providerId), expires: Date.now() + (providerId === "soon" ? 60_000 : 3_600_000) }, version: 1 }
      },
      list: async () => [],
      put: async () => ({ stored: true, version: 2 })
    })
    for (const providerId of ["soon", "later", "none"]) {
      await Promise.all([store.read(providerId), store.read(providerId)])
      await store.read(providerId)
    }
    expect(gets).toEqual(["soon", "soon", "later", "none", "none"])
  })
})
