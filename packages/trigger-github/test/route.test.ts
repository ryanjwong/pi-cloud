import { describe, expect, it } from "vitest"
import { defaultRoute, type GithubEvent, threadKey, threadOfKey } from "../src/index.ts"

const repository = { full_name: "acme/api" }
const sender = { login: "octocat", type: "User" }
const pr = {
  number: 7,
  title: "Retry flaky uploads",
  body: "Fixes #3",
  html_url: "https://github.com/acme/api/pull/7",
  head: { ref: "retry", sha: "0123456789abcdef0123" },
  base: { ref: "main" }
}
const event = (name: string, payload: GithubEvent["payload"]): GithubEvent => ({ name, delivery: "d", payload })
const route = defaultRoute()

describe("GitHub default routing", () => {
  it("routes a new issue to its thread", () => {
    const [routed] = route(event("issues", {
      action: "opened",
      repository,
      sender,
      issue: { number: 3, title: "Uploads fail", body: "Sometimes", html_url: "https://github.com/acme/api/issues/3" }
    }))
    expect(routed?.key).toBe("github:acme/api#3")
    expect(routed?.title).toBe("acme/api#3: Uploads fail")
    expect(routed?.content).toContain("New issue #3 in acme/api by @octocat: Uploads fail")
    expect(routed?.content).toContain("Sometimes")
  })

  it("routes pull request openings and pushes, with branch and commit", () => {
    const [opened] = route(event("pull_request", { action: "opened", repository, sender, pull_request: pr }))
    expect(opened?.key).toBe("github:acme/api#7")
    expect(opened?.content).toContain("Pull request opened: #7")
    expect(opened?.content).toContain("retry → main (0123456789ab)")
    expect(opened?.content).toContain("Fixes #3")

    const [pushed] = route(event("pull_request", { action: "synchronize", repository, sender, pull_request: pr }))
    expect(pushed?.content).toContain("New commits pushed to #7")
    expect(pushed?.content).not.toContain("Fixes #3")

    expect(route(event("pull_request", { action: "closed", repository, sender, pull_request: pr }))).toEqual([])
  })

  it("routes review comments and reviews to the pull request's thread", () => {
    const [comment] = route(event("pull_request_review_comment", {
      action: "created",
      repository,
      sender,
      pull_request: pr,
      comment: { body: "Off by one?", html_url: "https://x/c", path: "src/upload.ts" }
    }))
    expect(comment?.key).toBe("github:acme/api#7")
    expect(comment?.content).toContain("Review comment on #7 (src/upload.ts) by @octocat:")

    const [review] = route(event("pull_request_review", {
      action: "submitted",
      repository,
      sender,
      pull_request: pr,
      review: { body: "Needs tests", state: "changes_requested", html_url: "https://x/r" }
    }))
    expect(review?.content).toContain("Review (changes_requested) on #7")
  })

  it("ignores bots, unknown events, and unmentioned activity when a mention is required", () => {
    const comment = {
      action: "created",
      repository,
      issue: { number: 7, title: "t", html_url: "u" },
      comment: { body: "looks good", html_url: "u" }
    }
    expect(route(event("issue_comment", { ...comment, sender: { login: "ci", type: "Bot" } }))).toEqual([])
    expect(route(event("deployment", { action: "created", repository, sender }))).toEqual([])
    const mentioned = defaultRoute({ mention: "@pi" })
    expect(mentioned(event("issue_comment", { ...comment, sender }))).toEqual([])
    expect(mentioned(event("issue_comment", { ...comment, sender, comment: { body: "@pi look", html_url: "u" } }))).toHaveLength(1)
    expect(mentioned(event("pull_request", { action: "synchronize", repository, sender, pull_request: pr }))).toHaveLength(1)
  })

  it("parses thread keys back into repository and number", () => {
    expect(threadOfKey(threadKey("acme/api", 7))).toEqual({ repository: "acme/api", number: 7 })
    expect(threadOfKey("slack:C1:123")).toBeUndefined()
  })
})
