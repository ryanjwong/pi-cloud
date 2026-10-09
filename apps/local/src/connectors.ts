import type { Extension } from "@pi-cloud/control-plane"
import type { SessionSpec } from "@pi-cloud/protocol"
import { slackSource } from "@pi-cloud/source-slack"
import { sources } from "@pi-cloud/sources"
import { githubTrigger } from "@pi-cloud/trigger-github"
import { triggers } from "@pi-cloud/triggers"

/**
 * Triggers and sources enabled by environment variables:
 *
 * - `GITHUB_WEBHOOK_SECRET` (and optionally `GITHUB_MENTION`, e.g. `@pi`): `POST /v1/triggers/github`
 * - `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`: `POST /v1/sources/slack`
 *
 * Sessions they create use `PI_CLOUD_MODEL` (`provider/model`, default `anthropic/claude-opus-5-5`).
 */
export const connectorsFromEnv = (env: NodeJS.ProcessEnv = process.env): ReadonlyArray<Extension> => {
  const [provider, ...model] = (env.PI_CLOUD_MODEL ?? "anthropic/claude-opus-5-5").split("/")
  const spec: SessionSpec = { model: { provider: provider!, modelId: model.join("/") } }
  const extensions: Array<Extension> = []
  if (env.GITHUB_WEBHOOK_SECRET) {
    extensions.push(triggers([githubTrigger({ secret: env.GITHUB_WEBHOOK_SECRET, mention: env.GITHUB_MENTION, spec })]))
  }
  if (env.SLACK_SIGNING_SECRET && env.SLACK_BOT_TOKEN) {
    extensions.push(
      sources([slackSource({ signingSecret: env.SLACK_SIGNING_SECRET, botToken: env.SLACK_BOT_TOKEN, spec })])
    )
  }
  return extensions
}
