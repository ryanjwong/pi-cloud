import { SessionView } from "@pi-cloud/protocol"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { choices, latestFor } from "../src/pick.ts"

const repo = "https://github.com/acme/app"
const session = (id: string, createdAt: number, origin?: { url: string; branch: string }, title?: string) =>
  Schema.decodeUnknownSync(SessionView)({
    id,
    ...(title === undefined ? {} : { title }),
    createdAt,
    runner: { state: "idle" },
    spec: { model: { provider: "anthropic", modelId: "claude" }, ...(origin === undefined ? {} : { metadata: { origin } }) }
  })
const sessions = [
  session("ses_a", 1_000, { url: repo, branch: "main" }, "app@main"),
  session("ses_b", 5_000, { url: "https://github.com/acme/other", branch: "main" }, "other@main"),
  session("ses_c", 3_000, { url: repo, branch: "fix" }, "app@fix"),
  session("ses_d", 4_000)
]

describe("session picker", () => {
  it("lists this repository's sessions first, newest first, with coarse ages", () => {
    expect(choices(sessions, repo, 0).map((choice) => choice.value)).toEqual(["ses_c", "ses_a", "ses_b", "ses_d"])
    expect(choices(sessions, undefined, 0).map((choice) => choice.value)).toEqual(["ses_b", "ses_d", "ses_c", "ses_a"])
    expect(choices(sessions, repo, 3_000 + 7_200_000)[0]).toEqual({ value: "ses_c", label: "app@fix", description: "idle  anthropic/claude  2h" })
    expect([0, 120_000, 172_800_000].map((ago) => choices([session("ses_e", 0)], undefined, ago)[0]!.description))
      .toEqual(["idle  anthropic/claude  now", "idle  anthropic/claude  2m", "idle  anthropic/claude  2d"])
    expect(choices([session("ses_e", 0)], undefined, 0)[0]!.label).toBe("ses_e")
  })

  it("continues the latest session on the same origin and branch", () => {
    expect(latestFor(sessions, { url: repo, branch: "main" })?.id).toBe("ses_a")
    expect(latestFor(sessions, undefined)?.id).toBe("ses_d")
    expect(latestFor(sessions, { url: repo, branch: "gone" })).toBeUndefined()
  })
})
