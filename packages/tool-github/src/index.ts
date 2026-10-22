import { Type } from "@earendil-works/pi-ai"
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable"
import { definePlugin, type RunnerPlugin } from "@pi-cloud/runner"

export interface GithubToolsOptions {
  readonly credential?: string
  readonly apiUrl?: string
}

const text = (value: string) => [{ type: "text" as const, text: value }]

export const githubTools = (options: GithubToolsOptions = {}): RunnerPlugin =>
  definePlugin({
    name: "github",
    setup: async ({ session, secrets }) => {
      const apiUrl = options.apiUrl ?? "https://api.github.com"
      const bound = session.resolved?.repository
      if (bound === undefined || session.resolved?.untrusted === true) return {}
      const number = session.resolved?.thread
      const credential = options.credential ?? "GITHUB_TOKEN"
      const token = () => secrets(credential)
      if ((await token().catch(() => "unavailable")) === undefined) return {}
      const foreign = (repository: string) =>
        ({ isError: true, output: text(`403: ${repository} is not this session's repository (${bound})`) }) as const

      const request = async (method: string, path: string, body: unknown) => {
        const current = await token()
        if (current === undefined) throw new Error("No GitHub token is available to this session")
        const response = await fetch(`${apiUrl}${path}`, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${current}`,
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

      const repositoryParameter = Type.Optional(Type.String({ description: `owner/name; only ${bound}` }))

      const comment = defineTool({
        name: "github_comment",
        description: "Comment on a GitHub issue or pull request. Markdown is supported." +
          (number === undefined ? "" : ` Defaults to ${bound}#${number}, the thread this session is about.`),
        parameters: Type.Object({
          body: Type.String({ description: "The comment, in Markdown" }),
          repository: repositoryParameter,
          number: Type.Optional(Type.Number({ description: "Issue or pull request number; defaults to this session's" }))
        }),
        async execute(args) {
          const repository = args.repository ?? bound
          if (repository.toLowerCase() !== bound) return foreign(repository)
          const issue = args.number ?? number
          if (issue === undefined) return { isError: true, output: text("Which issue or pull request? Pass number.") }
          const posted = await request("POST", `/repos/${repository}/issues/${issue}/comments`, { body: args.body })
          return { output: text(`Commented on ${repository}#${issue}: ${posted.html_url ?? ""}`) }
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
          const repository = args.repository ?? bound
          if (repository.toLowerCase() !== bound) return foreign(repository)
          const opened = await request("POST", `/repos/${repository}/pulls`, {
            head: args.head,
            base: args.base,
            title: args.title,
            body: args.body ?? ""
          })
          return { output: text(`Opened ${opened.html_url ?? `a pull request on ${repository}`}`) }
        }
      })

      const context = section("github", () =>
        number === undefined
          ? undefined
          : `This session is about ${bound}#${number}. People there only see what you post with ` +
            `github_comment; reply there when you have an answer, a question, or finished work.`)

      return { extensions: [defineExtension({ name: "pi-cloud-github", tools: [comment, pullRequest], sections: [context] })] }
    }
  })
