import type { ControlPlaneEnv } from "@pi-cloud/config"
import type { Extension } from "@pi-cloud/control-plane"
import { SessionSecrets } from "@pi-cloud/core"
import { githubApp, githubAppTokens } from "@pi-cloud/github-app"
import type { SessionSpec } from "@pi-cloud/protocol"
import { slackSource } from "@pi-cloud/source-slack"
import { sources } from "@pi-cloud/sources"
import { githubTrigger } from "@pi-cloud/trigger-github"
import { triggers } from "@pi-cloud/triggers"
import { Option, Redacted } from "effect"

/** The triggers and sources whose secrets are configured. Sessions they create use `PI_CLOUD_MODEL`. */
export const connectors = (env: ControlPlaneEnv): ReadonlyArray<Extension> => {
  const [provider, ...model] = env.model.split("/")
  const spec: SessionSpec = { model: { provider: provider!, modelId: model.join("/") } }
  const extensions: Array<Extension> = []
  if (Option.isSome(env.github)) {
    const { webhookSecret, mention, sandboxProvider } = env.github.value
    // Each GitHub thread's session works in a sandbox of its repository, authenticated with GITHUB_TOKEN: the GitHub
    // App's installation token for that repository, or else the runner's own (listed in SANDBOX_SECRETS).
    const repositorySpec = (repository: string): SessionSpec => ({
      ...spec,
      sandbox: "repo",
      sandboxes: {
        repo: {
          provider: sandboxProvider,
          repository: { url: `https://github.com/${repository}.git`, credential: "GITHUB_TOKEN" }
        }
      }
    })
    extensions.push(
      triggers([githubTrigger({ secret: Redacted.value(webhookSecret), mention: Option.getOrUndefined(mention), spec: repositorySpec })])
    )
  }
  if (Option.isSome(env.slack)) {
    const { signingSecret, botToken } = env.slack.value
    extensions.push(
      sources([slackSource({ signingSecret: Redacted.value(signingSecret), botToken: Redacted.value(botToken), spec })])
    )
  }
  return extensions
}

/**
 * Secrets the control plane issues to sessions: with a GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`),
 * `GITHUB_TOKEN` is an installation token for the session's repository. The App's key stays here.
 */
export const sessionSecrets = (env: ControlPlaneEnv) =>
  Option.match(env.githubApp, {
    onNone: () => SessionSecrets.none,
    onSome: ({ appId, privateKey }) =>
      SessionSecrets.issuers(githubAppTokens(githubApp({ appId, privateKey: Redacted.value(privateKey) })))
  })
