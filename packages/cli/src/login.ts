import type { AuthInteraction, Credential } from "@earendil-works/pi-ai"
import { InMemoryCredentialStore } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"

export interface Connection {
  readonly url: string
  readonly apiKey?: string | undefined
}

const write = (text: string) => void process.stdout.write(text)

const request = async (connection: Connection, method: string, path: string, body?: unknown) => {
  const response = await fetch(new URL(path, connection.url), {
    method,
    headers: {
      "content-type": "application/json",
      ...(connection.apiKey === undefined ? {} : { authorization: `Bearer ${connection.apiKey}` })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
  return response.status === 204 ? undefined : response.json()
}

/** Store a credential on the control plane, where every runner uses (and refreshes) it. */
export const upload = (connection: Connection, providerId: string, credential: Credential) =>
  request(connection, "PUT", `/v1/credentials/${encodeURIComponent(providerId)}`, credential)

/** Providers with a login (subscriptions such as ChatGPT/Codex and Claude Pro/Max, and other OAuth logins). */
export const loginProviders = () =>
  builtinProviders()
    .filter((provider) => provider.auth.oauth !== undefined)
    .map((provider) => ({ id: provider.id, name: provider.auth.oauth!.loginLabel ?? provider.auth.oauth!.name }))

const openBrowser = (url: string) => {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref()
  } catch {
    // No browser here: the URL is printed.
  }
}

/** pi-ai's login interaction in a plain terminal: prompts on stdin, links and codes on stdout. */
const terminalInteraction = (signal: AbortSignal): AuthInteraction & { close(): void } => {
  const input = createInterface({ input: process.stdin, output: process.stdout })
  return {
    signal,
    async prompt(prompt) {
      if (prompt.type === "select") {
        prompt.options.forEach((option, index) =>
          write(`  ${index + 1}. ${option.label}${option.description ? ` (${option.description})` : ""}\n`))
        const answer = await input.question(`${prompt.message} [1-${prompt.options.length}] `)
        return prompt.options[Number(answer) - 1]?.id ?? prompt.options[0]!.id
      }
      return input.question(`${prompt.message} `)
    },
    notify(event) {
      if (event.type === "auth_url") {
        write(`\nOpen this URL to sign in${event.instructions ? ` (${event.instructions})` : ""}:\n  ${event.url}\n\n`)
        openBrowser(event.url)
      } else if (event.type === "device_code") {
        write(`\nGo to ${event.verificationUri} and enter the code ${event.userCode}\n\n`)
        openBrowser(event.verificationUri)
      } else write(`${event.message}\n`)
    },
    close: () => input.close()
  }
}

/**
 * Sign in to a provider here (it needs your browser), with the provider's own login flow as Pi runs it, then store
 * the credential on the control plane. Nothing stays on this machine.
 */
export const login = async (connection: Connection, providerId: string) => {
  const store = new InMemoryCredentialStore()
  const models = createModels({ credentials: store })
  for (const provider of builtinProviders()) models.setProvider(provider)
  const controller = new AbortController()
  const interaction = terminalInteraction(controller.signal)
  try {
    const credential = await models.login(providerId, "oauth", interaction)
    await upload(connection, providerId, credential)
    write(`Signed in to ${providerId}; the credential is stored on ${connection.url}.\n`)
  } finally {
    interaction.close()
  }
}

/** Import logins from Pi's own credential file (`~/.pi/agent/auth.json`). */
export const importFromPi = async (connection: Connection, providerIds: ReadonlyArray<string>) => {
  const file = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json")
  const entries = JSON.parse(await readFile(file, "utf8")) as Record<string, Credential>
  const selected = providerIds.length === 0 ? Object.keys(entries) : providerIds
  for (const providerId of selected) {
    const credential = entries[providerId]
    if (credential === undefined) throw new Error(`No ${providerId} login in ${file}`)
    await upload(connection, providerId, credential)
    write(`Imported ${providerId} (${credential.type}) from ${file}.\n`)
  }
}

/** Import a ChatGPT login from the Codex CLI (`~/.codex/auth.json`, written by `codex login`). */
export const importFromCodex = async (connection: Connection) => {
  const file = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json")
  const auth = JSON.parse(await readFile(file, "utf8")) as {
    tokens?: { access_token?: string; refresh_token?: string; account_id?: string }
  }
  const { access_token: access, refresh_token: refresh, account_id: accountId } = auth.tokens ?? {}
  if (!access || !refresh) throw new Error(`${file} has no ChatGPT login; run \`codex login\` first`)
  // The access token's expiry is in its JWT payload.
  const payload = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number }
  const credential: Credential = {
    type: "oauth",
    access,
    refresh,
    expires: (payload.exp ?? 0) * 1000,
    ...(accountId === undefined ? {} : { accountId })
  }
  await upload(connection, "openai-codex", credential)
  write(`Imported the ChatGPT login from ${file} as openai-codex.\n`)
}

export const logout = async (connection: Connection, providerId: string) => {
  await request(connection, "DELETE", `/v1/credentials/${encodeURIComponent(providerId)}`)
  write(`Removed the ${providerId} credential.\n`)
}

export const listCredentials = async (connection: Connection) => {
  const stored = (await request(connection, "GET", "/v1/credentials")) as Array<{ providerId: string; type: string; expires?: number }>
  if (stored.length === 0) write("No stored credentials. `pi-cloud login <provider>` adds one.\n")
  for (const entry of stored) write(`${entry.providerId.padEnd(16)} ${entry.type}\n`)
  write(`\nProviders with a login: ${loginProviders().map((provider) => provider.id).join(", ")}\n`)
}
