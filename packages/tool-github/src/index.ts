import { Type } from "@earendil-works/pi-ai"
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable"
import { definePlugin, type RunnerPlugin } from "@pi-cloud/runner"

/** The GitHub thread a session is about, as the GitHub trigger records it in the session's metadata. */
export interface GithubThread {
  readonly repository: string
  readonly number: number
}

export interface GithubToolsOptions {
  /** A token that may comment and open pull requests on the repositories the agent works on. */
  readonly token: string
  /** REST API base URL; override for GitHub Enterprise or tests. */
  readonly apiUrl?: string
}

const text = (value: string) => [{ type: "text" as const, text: value }]

/** The thread recorded by the GitHub trigger in `spec.metadata.github`, if the session has one. */
export const threadOf = (metadata: Readonly<Record<string, unknown>> | undefined): GithubThread | undefined => {
  const github = metadata?.github as { repository?: unknown; number?: unknown } | undefined
  return typeof github?.repository === "string" && typeof github.number === "number"
    ? { repository: github.repository, number: github.number }
    : undefined
}

/**
 * GitHub tools, run by the runner itself (not inside a sandbox, so the token stays out of the agent's reach):
 *
 * - `github_comment` comments on an issue or pull request; in a session started by the GitHub trigger it
 *   defaults to that thread, which is how the agent answers the people who mentioned it.
 * - `github_open_pull_request` opens a pull request from a pushed branch.
 */
export const githubTools = (options: GithubToolsOptions): RunnerPlugin =>
  definePlugin({
    name: "github",
    setup: ({ session }) => {
      const apiUrl = options.apiUrl ?? "https://api.github.com"
      const thread = threadOf(session.spec.metadata)

      const request = async (method: string, path: string, body: unknown) => {
        const response = await fetch(`${apiUrl}${path}`, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
            "user-agent": "pi-cloud",
            "x-github-api-version": "2022-11-28"
          },
          body: JSON.stringify(body)
        })
        const result = (await response.json().catch(() => ({}))) as { html_url?: string; message?: string }
        if (!response.ok) throw new Error(`GitHub ${response.status}: ${result.message ?? response.statusText}`)
        return result
      }

      const repositoryParameter = Type.Optional(Type.String({ description: "owner/name; defaults to this session's repository" }))

      const comment = defineTool({
        name: "github_comment",
        description: "Comment on a GitHub issue or pull request. Markdown is supported." +
          (thread === undefined ? "" : ` Defaults to ${thread.repository}#${thread.number}, the thread this session is about.`),
        parameters: Type.Object({
          body: Type.String({ description: "The comment, in Markdown" }),
          repository: repositoryParameter,
          number: Type.Optional(Type.Number({ description: "Issue or pull request number; defaults to this session's" }))
        }),
        async execute(args) {
          const repository = args.repository ?? thread?.repository
          const number = args.number ?? thread?.number
          if (repository === undefined || number === undefined) {
            return { isError: true, content: text("Which issue or pull request? Pass repository and number.") }
          }
          const posted = await request("POST", `/repos/${repository}/issues/${number}/comments`, { body: args.body })
          return { content: text(`Commented on ${repository}#${number}: ${posted.html_url ?? ""}`) }
        }
      })

      const pullRequest = defineTool({
        name: "github_open_pull_request",
        description: "Open a pull request from a branch you have pushed.",
        parameters: Type.Object({
          head: Type.String({ description: "The pushed branch with your changes" }),
          base: Type.String({ description: "The branch to merge into, e.g. main" }),
          title: Type.String(),
          body: Type.Optional(Type.String({ description: "Description, in Markdown" })),
          repository: repositoryParameter
        }),
        async execute(args) {
          const repository = args.repository ?? thread?.repository
          if (repository === undefined) return { isError: true, content: text("Which repository? Pass repository.") }
          const opened = await request("POST", `/repos/${repository}/pulls`, {
            head: args.head,
            base: args.base,
            title: args.title,
            body: args.body ?? ""
          })
          return { content: text(`Opened ${opened.html_url ?? `a pull request on ${repository}`}`) }
        }
      })

      const context = section("github", () =>
        thread === undefined
          ? undefined
          : `This session is about ${thread.repository}#${thread.number}. People there only see what you post with ` +
            `github_comment; reply there when you have an answer, a question, or finished work.`)

      return { extensions: [defineExtension({ name: "pi-cloud-github", tools: [comment, pullRequest], sections: [context] })] }
    }
  })
