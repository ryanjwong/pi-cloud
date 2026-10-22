import { appManifest } from "@pi-cloud/github-app"
import { createApp } from "@pi-cloud/github-app/node"
import { existsSync } from "node:fs"
import { openBrowser } from "./login.ts"
import { paths } from "./settings.ts"
import { writeSopsSecrets } from "./sops.ts"

export interface GithubAppFlags {
  readonly org?: string | undefined
  readonly name?: string | undefined
  readonly url?: string | undefined
  readonly secrets?: string | undefined
  readonly print?: boolean | undefined
  readonly manifest?: boolean | undefined
}

const isLocal = (url: string) => /^https?:\/\/(127\.|localhost|\[::1\])/.test(url)

export const githubAppCommand = async (flags: GithubAppFlags, write: (text: string) => void) => {
  const publicUrl = flags.url === undefined || isLocal(flags.url) ? undefined : flags.url
  const options = { ...(flags.name === undefined ? {} : { name: flags.name }), ...(publicUrl === undefined ? {} : { publicUrl }) }
  if (flags.manifest === true) {
    return write(`${JSON.stringify(appManifest({ ...options, redirectUrl: "http://127.0.0.1/callback" }), null, 2)}\n`)
  }
  const secrets = flags.secrets ?? paths().secrets
  if (flags.print !== true && !existsSync(secrets)) throw new Error(`No ${secrets}: run pi-cloud init, pass --secrets <file>, or --print`)
  if (publicUrl === undefined) write("No public --url: the App gets no webhook, so it provides tokens but no GitHub trigger.\n")

  const created = await createApp({
    ...options,
    ...(flags.org === undefined ? {} : { org: flags.org }),
    open: (url) => {
      write(`Opening ${url} to create the App on GitHub${flags.org === undefined ? "" : ` for ${flags.org}`}...\n`)
      openBrowser(url)
    }
  })
  const values: Record<string, string> = {
    GITHUB_APP_ID: String(created.id),
    GITHUB_APP_PRIVATE_KEY: created.privateKey,
    ...(created.webhookSecret === undefined ? {} : { GITHUB_WEBHOOK_SECRET: created.webhookSecret })
  }
  if (flags.print === true) {
    for (const [key, value] of Object.entries(values)) write(`${key}=${JSON.stringify(value)}\n`)
  } else {
    writeSopsSecrets(secrets, values)
    write(`Stored ${Object.keys(values).join(", ")} in ${secrets}.\n`)
  }
  write(`Created ${created.htmlUrl}. Install it on your repositories: ${created.htmlUrl}/installations/new\n`)
}
