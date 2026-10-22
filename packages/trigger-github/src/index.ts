import type { SessionSpec } from "@pi-cloud/protocol"
import { defineTrigger, parseJson, sha256Hex, type Trigger, type TriggerEvent, verifyHmac } from "@pi-cloud/triggers"
import { Effect } from "effect"

export interface GithubPayload {
  readonly action?: string
  readonly repository?: { readonly full_name: string }
  readonly sender?: { readonly login: string; readonly type?: string }
  readonly issue?: {
    readonly number: number
    readonly title: string
    readonly body?: string | null
    readonly html_url: string
    readonly author_association?: string
    readonly pull_request?: unknown
  }
  readonly pull_request?: {
    readonly number: number
    readonly title: string
    readonly body?: string | null
    readonly html_url: string
    readonly author_association?: string
    readonly head?: { readonly ref: string; readonly sha: string; readonly repo?: { readonly full_name: string } | null }
    readonly base?: { readonly ref: string }
  }
  readonly comment?: { readonly body: string; readonly html_url: string; readonly path?: string; readonly author_association?: string }
  readonly review?: { readonly body?: string | null; readonly state: string; readonly html_url: string; readonly author_association?: string }
}

export interface GithubEvent {
  readonly name: string
  readonly delivery: string | undefined
  readonly payload: GithubPayload
}

export const threadKey = (repository: string, number: number) => `github:${repository}#${number}`

export const threadOfKey = (key: string): { readonly repository: string; readonly number: number } | undefined => {
  const match = /^github:([^#]+)#(\d+)$/.exec(key)
  return match === null ? undefined : { repository: match[1]!, number: Number(match[2]) }
}

const text = (lines: ReadonlyArray<string | null | undefined | false>) => lines.filter(Boolean).join("\n")

const DEFAULT_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"]

export interface RouteOptions {
  readonly mention?: string | undefined
  readonly allowedAssociations?: ReadonlyArray<string> | undefined
}

export const defaultRoute = (options: RouteOptions = {}) =>
(event: GithubEvent): ReadonlyArray<Omit<TriggerEvent, "spec">> => {
  const { payload } = event
  const repository = payload.repository?.full_name
  if (repository === undefined || payload.sender?.type === "Bot") return []
  const by = `@${payload.sender?.login ?? "someone"}`
  const mention = options.mention === undefined
    ? undefined
    : new RegExp(`(?<![\\w@/-])${options.mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i")
  const allowed = (association: string | undefined, body: string | null | undefined) =>
    association !== undefined && (options.allowedAssociations ?? DEFAULT_ASSOCIATIONS).includes(association) &&
    (mention === undefined || mention.test(body ?? ""))
  const forked = (pr: NonNullable<GithubPayload["pull_request"]>) => pr.head?.repo?.full_name !== repository

  switch (event.name) {
    case "issues": {
      const issue = payload.issue
      if (issue === undefined || payload.action !== "opened" || !allowed(issue.author_association, `${issue.title}\n${issue.body}`)) return []
      return [{
        key: threadKey(repository, issue.number),
        title: `${repository}#${issue.number}: ${issue.title}`,
        content: text([`New issue #${issue.number} in ${repository} by ${by}: ${issue.title}`, issue.body, issue.html_url])
      }]
    }
    case "pull_request": {
      const pr = payload.pull_request
      if (pr === undefined || !["opened", "reopened", "synchronize", "ready_for_review"].includes(payload.action ?? "")) {
        return []
      }
      if (!allowed(pr.author_association, `${pr.title}\n${pr.body}`)) return []
      const what = payload.action === "synchronize" ? `New commits pushed to` : `Pull request ${payload.action}:`
      return [{
        key: threadKey(repository, pr.number),
        title: `${repository}#${pr.number}: ${pr.title}`,
        untrusted: forked(pr),
        content: text([
          `${what} #${pr.number} in ${repository} by ${by}: ${pr.title}`,
          pr.head && pr.base && `${pr.head.ref} → ${pr.base.ref} (${pr.head.sha.slice(0, 12)})`,
          payload.action === "opened" && pr.body,
          pr.html_url
        ])
      }]
    }
    case "issue_comment": {
      const { issue, comment } = payload
      if (issue === undefined || comment === undefined || payload.action !== "created" || !allowed(comment.author_association, comment.body)) return []
      const kind = issue.pull_request === undefined ? "issue" : "pull request"
      return [{
        key: threadKey(repository, issue.number),
        title: `${repository}#${issue.number}: ${issue.title}`,
        untrusted: issue.pull_request !== undefined,
        content: text([`Comment on ${kind} #${issue.number} by ${by}:`, comment.body, comment.html_url])
      }]
    }
    case "pull_request_review_comment": {
      const { pull_request: pr, comment } = payload
      if (pr === undefined || comment === undefined || payload.action !== "created" || !allowed(comment.author_association, comment.body)) return []
      return [{
        key: threadKey(repository, pr.number),
        title: `${repository}#${pr.number}: ${pr.title}`,
        untrusted: forked(pr),
        content: text([`Review comment on #${pr.number}${comment.path ? ` (${comment.path})` : ""} by ${by}:`, comment.body, comment.html_url])
      }]
    }
    case "pull_request_review": {
      const { pull_request: pr, review } = payload
      if (pr === undefined || review === undefined || payload.action !== "submitted" || !allowed(review.author_association, review.body)) return []
      return [{
        key: threadKey(repository, pr.number),
        title: `${repository}#${pr.number}: ${pr.title}`,
        untrusted: forked(pr),
        content: text([`Review (${review.state}) on #${pr.number} by ${by}:`, review.body, review.html_url])
      }]
    }
    default:
      return []
  }
}

export interface GithubTriggerOptions {
  readonly secret: string
  readonly name?: string
  readonly spec?: SessionSpec | ((repository: string) => SessionSpec)
  readonly mention?: string | undefined
  readonly allowedAssociations?: ReadonlyArray<string> | undefined
  readonly route?: (event: GithubEvent) => ReadonlyArray<Omit<TriggerEvent, "spec">>
}

export const githubTrigger = (options: GithubTriggerOptions): Trigger => {
  if (options.secret === "") throw new Error("The GitHub trigger needs a webhook secret")
  const route = options.route ?? defaultRoute(options)
  return defineTrigger({
    name: options.name ?? "github",
    handle: (request) =>
      Effect.gen(function*() {
        yield* verifyHmac(request, "x-hub-signature-256", options.secret)
        const event: GithubEvent = {
          name: request.headers["x-github-event"] ?? "",
          delivery: request.headers["x-github-delivery"],
          payload: (yield* parseJson(request)) as GithubPayload
        }
        const repository = event.payload.repository?.full_name ?? ""
        const spec = typeof options.spec === "function" ? options.spec(repository) : options.spec
        const digest = yield* Effect.promise(() => sha256Hex(request.body))
        return route(event).map((routed, index) => ({
          ...routed,
          spec,
          repository,
          thread: threadOfKey(routed.key)?.number,
          requestId: routed.requestId ?? `${digest}:${index}`
        }))
      })
  })
}
