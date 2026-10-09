import type { SessionSpec } from "@pi-cloud/protocol"
import { defineTrigger, parseJson, type Trigger, type TriggerEvent, verifyHmac } from "@pi-cloud/triggers"
import { Effect } from "effect"

/** The fields of GitHub webhook payloads this trigger reads. */
export interface GithubPayload {
  readonly action?: string
  readonly repository?: { readonly full_name: string }
  readonly sender?: { readonly login: string; readonly type?: string }
  readonly issue?: {
    readonly number: number
    readonly title: string
    readonly body?: string | null
    readonly html_url: string
    readonly pull_request?: unknown
  }
  readonly pull_request?: {
    readonly number: number
    readonly title: string
    readonly body?: string | null
    readonly html_url: string
    readonly head?: { readonly ref: string; readonly sha: string }
    readonly base?: { readonly ref: string }
  }
  readonly comment?: { readonly body: string; readonly html_url: string; readonly path?: string }
  readonly review?: { readonly body?: string | null; readonly state: string; readonly html_url: string }
}

/** One GitHub delivery: its event name (`X-GitHub-Event`), delivery id, and payload. */
export interface GithubEvent {
  readonly name: string
  readonly delivery: string | undefined
  readonly payload: GithubPayload
}

/** Events about one issue or pull request share a key, so they reach the same session. */
export const threadKey = (repository: string, number: number) => `github:${repository}#${number}`

/** The repository and number a thread key refers to. */
export const threadOfKey = (key: string): { readonly repository: string; readonly number: number } | undefined => {
  const match = /^github:([^#]+)#(\d+)$/.exec(key)
  return match === null ? undefined : { repository: match[1]!, number: Number(match[2]) }
}

const text = (lines: ReadonlyArray<string | null | undefined | false>) => lines.filter(Boolean).join("\n")

/**
 * The default mapping: new issues and pull requests, comments, and reviews become prompts for the thread's
 * session. Bots and (with `mention`) comments that do not mention the agent are ignored.
 */
export const defaultRoute = (options: { readonly mention?: string | undefined } = {}) =>
(event: GithubEvent): ReadonlyArray<Omit<TriggerEvent, "spec">> => {
  const { payload } = event
  const repository = payload.repository?.full_name
  if (repository === undefined || payload.sender?.type === "Bot") return []
  const by = `@${payload.sender?.login ?? "someone"}`
  const mentioned = (body: string | null | undefined) => options.mention === undefined || (body ?? "").includes(options.mention)

  switch (event.name) {
    case "issues": {
      const issue = payload.issue
      if (issue === undefined || payload.action !== "opened" || !mentioned(`${issue.title}\n${issue.body}`)) return []
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
      if (payload.action === "opened" && !mentioned(`${pr.title}\n${pr.body}`)) return []
      const what = payload.action === "synchronize" ? `New commits pushed to` : `Pull request ${payload.action}:`
      return [{
        key: threadKey(repository, pr.number),
        title: `${repository}#${pr.number}: ${pr.title}`,
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
      if (issue === undefined || comment === undefined || payload.action !== "created" || !mentioned(comment.body)) return []
      const kind = issue.pull_request === undefined ? "issue" : "pull request"
      return [{
        key: threadKey(repository, issue.number),
        title: `${repository}#${issue.number}: ${issue.title}`,
        content: text([`Comment on ${kind} #${issue.number} by ${by}:`, comment.body, comment.html_url])
      }]
    }
    case "pull_request_review_comment": {
      const { pull_request: pr, comment } = payload
      if (pr === undefined || comment === undefined || payload.action !== "created" || !mentioned(comment.body)) return []
      return [{
        key: threadKey(repository, pr.number),
        title: `${repository}#${pr.number}: ${pr.title}`,
        content: text([`Review comment on #${pr.number}${comment.path ? ` (${comment.path})` : ""} by ${by}:`, comment.body, comment.html_url])
      }]
    }
    case "pull_request_review": {
      const { pull_request: pr, review } = payload
      if (pr === undefined || review === undefined || payload.action !== "submitted" || !mentioned(review.body)) return []
      return [{
        key: threadKey(repository, pr.number),
        title: `${repository}#${pr.number}: ${pr.title}`,
        content: text([`Review (${review.state}) on #${pr.number} by ${by}:`, review.body, review.html_url])
      }]
    }
    default:
      return []
  }
}

export interface GithubTriggerOptions {
  /** The webhook secret configured on GitHub; deliveries without a valid `X-Hub-Signature-256` are refused. */
  readonly secret: string
  /** Mounted at `/v1/triggers/{name}`. Defaults to `github`. */
  readonly name?: string
  /**
   * Spec for new sessions, e.g. a sandbox of the repository (`{ sandbox: "repo", sandboxes: { repo: { provider,
   * repository: { url, credential } } } }`). The thread is added to its `metadata.github`.
   */
  readonly spec?: SessionSpec | ((repository: string) => SessionSpec)
  /** Only react to comments, issues and pull requests that contain this text, e.g. `@pi`. */
  readonly mention?: string
  /** Replace the default mapping from deliveries to events. */
  readonly route?: (event: GithubEvent) => ReadonlyArray<Omit<TriggerEvent, "spec">>
}

/**
 * GitHub webhooks as a trigger. Each issue or pull request gets its own session, which every later event about it
 * reaches. Redelivered webhooks are deduplicated by delivery id.
 */
export const githubTrigger = (options: GithubTriggerOptions): Trigger =>
  defineTrigger({
    name: options.name ?? "github",
    handle: (request) =>
      Effect.gen(function*() {
        yield* verifyHmac(request, "x-hub-signature-256", options.secret)
        const event: GithubEvent = {
          name: request.headers["x-github-event"] ?? "",
          delivery: request.headers["x-github-delivery"],
          payload: (yield* parseJson(request)) as GithubPayload
        }
        const route = options.route ?? defaultRoute({ mention: options.mention })
        const repository = event.payload.repository?.full_name ?? ""
        const spec = typeof options.spec === "function" ? options.spec(repository) : options.spec
        return route(event).map((routed, index) => {
          // New sessions record their thread, so GitHub tools know where to reply.
          const thread = threadOfKey(routed.key)
          return {
            ...routed,
            spec: thread === undefined ? spec : { ...spec, metadata: { ...spec?.metadata, github: thread } },
            requestId: routed.requestId ?? (event.delivery === undefined ? undefined : `${event.delivery}:${index}`)
          }
        })
      })
  })
