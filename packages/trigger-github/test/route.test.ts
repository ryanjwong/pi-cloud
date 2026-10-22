import { describe, expect, it } from "vitest"
import { hmacSha256Hex } from "@pi-cloud/triggers"
import { Effect } from "effect"
import { defaultRoute, type GithubEvent, githubTrigger, threadKey, threadOfKey } from "../src/index.ts"

const repository = { full_name: "acme/api" }
const sender = { login: "octocat", type: "User" }
const pr = {
  number: 7,
  title: "Retry flaky uploads",
  body: "Fixes #3",
  html_url: "https://github.com/acme/api/pull/7",
  author_association: "MEMBER",
  head: { ref: "retry", sha: "0123456789abcdef0123", repo: repository },
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
      issue: { number: 3, title: "Uploads fail", body: "Sometimes", html_url: "https://github.com/acme/api/issues/3", author_association: "OWNER" }
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
      comment: { body: "Off by one?", html_url: "https://x/c", path: "src/upload.ts", author_association: "COLLABORATOR" }
    }))
    expect(comment?.key).toBe("github:acme/api#7")
    expect(comment?.content).toContain("Review comment on #7 (src/upload.ts) by @octocat:")

    const [review] = route(event("pull_request_review", {
      action: "submitted",
      repository,
      sender,
      pull_request: pr,
      review: { body: "Needs tests", state: "changes_requested", html_url: "https://x/r", author_association: "MEMBER" }
    }))
    expect(review?.content).toContain("Review (changes_requested) on #7")
  })

  it("ignores bots, unknown events, and unmentioned activity when a mention is required", () => {
    const comment = {
      action: "created",
      repository,
      issue: { number: 7, title: "t", html_url: "u" },
      comment: { body: "looks good", html_url: "u", author_association: "MEMBER" }
    }
    expect(route(event("issue_comment", { ...comment, sender: { login: "ci", type: "Bot" } }))).toEqual([])
    expect(route(event("deployment", { action: "created", repository, sender }))).toEqual([])
    const mentioned = defaultRoute({ mention: "@pi" })
    expect(mentioned(event("issue_comment", { ...comment, sender }))).toEqual([])
    const says = (body: string, author_association = "MEMBER") =>
      mentioned(event("issue_comment", { ...comment, sender, comment: { body, html_url: "u", author_association } }))
    expect(says("@pi look")).toHaveLength(1)
    expect(says("@PI, look")).toHaveLength(1)
    expect(says("@pinky look")).toEqual([])
    expect(says("me@pi.dev look")).toEqual([])
    expect(says("@pi look", "NONE")).toEqual([])
    expect(says("@pi look", "CONTRIBUTOR")).toEqual([])
    expect(mentioned(event("pull_request", { action: "synchronize", repository, sender, pull_request: pr }))).toEqual([])
    expect(mentioned(event("pull_request", { action: "synchronize", repository, sender, pull_request: { ...pr, body: "@pi review" } })))
      .toHaveLength(1)
  })

  it("checks the author association on every action, with no mention configured", () => {
    const outsider = { ...pr, author_association: "NONE" }
    for (const action of ["opened", "reopened", "synchronize", "ready_for_review"]) {
      expect(route(event("pull_request", { action, repository, sender, pull_request: outsider }))).toEqual([])
    }
    expect(defaultRoute({ allowedAssociations: ["NONE"] })(event("pull_request", { action: "opened", repository, sender, pull_request: outsider })))
      .toHaveLength(1)
  })

  it("runs pull requests from forks, and comments on any pull request, without template secrets", () => {
    const fork = { ...pr, head: { ...pr.head, repo: { full_name: "mallory/api" } } }
    const comment = { body: "@pi fix", html_url: "u", author_association: "MEMBER" }
    const review = { ...comment, state: "commented" }
    const untrusted = (name: string, payload: object) => route(event(name, { repository, sender, ...payload }))[0]?.untrusted
    for (const [pull_request, expected] of [[pr, false], [fork, true]] as const) {
      expect(untrusted("pull_request", { action: "opened", pull_request })).toBe(expected)
      expect(untrusted("pull_request_review_comment", { action: "created", pull_request, comment })).toBe(expected)
      expect(untrusted("pull_request_review", { action: "submitted", pull_request, review })).toBe(expected)
    }
    const issue = { number: 7, title: "t", html_url: "u" }
    expect(untrusted("issue_comment", { action: "created", issue, comment })).toBe(false)
    expect(untrusted("issue_comment", { action: "created", issue: { ...issue, pull_request: {} }, comment })).toBe(true)
  })

  it("refuses to start without a secret and deduplicates replayed bodies whatever their delivery id", async () => {
    expect(() => githubTrigger({ secret: "" })).toThrow(/secret/)
    const trigger = githubTrigger({ secret: "s" })
    const body = JSON.stringify({
      action: "opened",
      repository,
      sender,
      issue: { number: 3, title: "t", html_url: "u", author_association: "OWNER" }
    })
    const deliver = async (delivery: string) =>
      Effect.runPromise(trigger.handle({
        body,
        url: new URL("http://localhost"),
        headers: { "x-github-event": "issues", "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${await hmacSha256Hex("s", body)}` }
      }))
    const [first] = await deliver("d1")
    const [replayed] = await deliver("d2")
    expect(first?.requestId).toBe(replayed?.requestId)
    expect(first).toMatchObject({ repository: "acme/api", thread: 3 })
  })

  it("parses thread keys back into repository and number", () => {
    expect(threadOfKey(threadKey("acme/api", 7))).toEqual({ repository: "acme/api", number: 7 })
    expect(threadOfKey("slack:C1:123")).toBeUndefined()
  })
})
