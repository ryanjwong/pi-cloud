import type { ControlPlaneEnv } from "@pi-cloud/config"
import type { Extension } from "@pi-cloud/control-plane"
import { RepositoryAccess, SessionSecrets } from "@pi-cloud/core"
import { githubApp, githubAppTokens, installedRepositories, publicRepositories } from "@pi-cloud/github-app"
import type { SessionSpec } from "@pi-cloud/protocol"
import { slackSource } from "@pi-cloud/source-slack"
import { sources } from "@pi-cloud/sources"
import { githubTrigger } from "@pi-cloud/trigger-github"
import { triggers } from "@pi-cloud/triggers"
import { Option, Redacted } from "effect"

export const connectors = (env: Pick<ControlPlaneEnv, "model" | "github" | "githubApp"> & Partial<Pick<ControlPlaneEnv, "slack">>) => {
  const [provider, ...model] = env.model.split("/")
  const spec: SessionSpec = { model: { provider: provider!, modelId: model.join("/") } }
  const extensions: Array<Extension> = []
  if (Option.isSome(env.github)) {
    const { webhookSecret, mention, allowedAssociations, template } = env.github.value
    const repositorySpec = (repository: string): SessionSpec => ({
      ...spec,
      sandbox: "repo",
      sandboxes: { repo: { template, repository: `https://github.com/${repository}.git` } }
    })
    extensions.push(
      triggers([githubTrigger({ secret: Redacted.value(webhookSecret), mention, allowedAssociations, spec: repositorySpec })])
    )
  }
  const slack = env.slack ?? Option.none()
  if (Option.isSome(slack)) {
    const { signingSecret, botToken, allowedUsers, allowedChannels } = slack.value
    extensions.push(
      sources([slackSource({ signingSecret: Redacted.value(signingSecret), botToken: Redacted.value(botToken), allowedUsers, allowedChannels, spec })])
    )
  }
  const app = Option.map(env.githubApp, ({ appId, privateKey }) => githubApp({ appId, privateKey: Redacted.value(privateKey) }))
  return {
    extensions,
    sessionSecrets: Option.match(app, { onNone: () => SessionSecrets.none, onSome: (app) => SessionSecrets.issuers(githubAppTokens(app)) }),
    repositoryAccess: RepositoryAccess.make(Option.match(app, { onNone: () => publicRepositories(), onSome: installedRepositories }))
  }
}
