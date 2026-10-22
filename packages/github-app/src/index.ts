import type { Session } from "@pi-cloud/protocol"
import { APP_PERMISSIONS } from "./manifest.ts"

export * from "./manifest.ts"

export interface GithubAppOptions {
  readonly appId: string
  readonly privateKey: string
  readonly apiUrl?: string
  readonly permissions?: Readonly<Record<string, "read" | "write">>
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export interface InstallationToken {
  readonly token: string
  readonly expiresAt: number
}

export interface GithubApp {
  installationToken(repositories: ReadonlyArray<string>): Promise<InstallationToken>
}

const REUSE_MARGIN_MS = 5 * 60_000

const base64url = (bytes: Uint8Array) => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
const utf8 = (value: string) => new TextEncoder().encode(value)

const derLength = (length: number) =>
  length < 0x80 ? [length] : length < 0x100 ? [0x81, length] : length < 0x10000 ? [0x82, length >> 8, length & 0xff] : [0x83, length >> 16, (length >> 8) & 0xff, length & 0xff]

const pkcs1ToPkcs8 = (pkcs1: Uint8Array) => {
  const version = [0x02, 0x01, 0x00]
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]
  const key = [0x04, ...derLength(pkcs1.length)]
  const body = version.length + algorithm.length + key.length + pkcs1.length
  const out = new Uint8Array([0x30, ...derLength(body), ...version, ...algorithm, ...key, ...pkcs1])
  return out
}

const importKey = (pem: string) => {
  const text = pem.replace(/\\n/g, "\n").trim()
  const pkcs1 = text.includes("BEGIN RSA PRIVATE KEY")
  if (!pkcs1 && !text.includes("BEGIN PRIVATE KEY")) throw new Error("The GitHub App private key is not a PEM private key")
  const binary = atob(text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""))
  const der = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs1 ? pkcs1ToPkcs8(der) : der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  )
}

export const githubApp = (options: GithubAppOptions): GithubApp => {
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "")
  const request = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const permissions = options.permissions ?? APP_PERMISSIONS
  const key = importKey(options.privateKey)
  key.catch(() => {})

  const jwt = async () => {
    const seconds = Math.floor(now() / 1000)
    const header = base64url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })))
    const payload = base64url(utf8(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: options.appId })))
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await key, utf8(`${header}.${payload}`))
    return `${header}.${payload}.${base64url(new Uint8Array(signature))}`
  }

  const call = async <A>(method: string, path: string, body?: unknown): Promise<A> => {
    const response = await request(`${apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${await jwt()}`,
        "user-agent": "pi-cloud",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const result = (await response.json().catch(() => ({}))) as A & { message?: string }
    if (!response.ok) throw new Error(`GitHub ${response.status} on ${method} ${path}: ${result.message ?? response.statusText}`)
    return result
  }

  const installations = new Map<string, Promise<number>>()
  const installationOf = (repository: string) => {
    let found = installations.get(repository)
    if (found === undefined) {
      found = call<{ id: number }>("GET", `/repos/${repository}/installation`).then((installation) => installation.id)
      found.catch(() => installations.delete(repository))
      installations.set(repository, found)
    }
    return found
  }

  const tokens = new Map<string, Promise<InstallationToken>>()
  return {
    async installationToken(repositories) {
      const names = [...new Set(repositories.map((repository) => repository.toLowerCase()))].sort()
      if (names.length === 0) throw new Error("A GitHub App token needs at least one repository")
      const owners = new Set(names.map((name) => name.split("/")[0]))
      if (owners.size > 1) throw new Error("A GitHub App token covers repositories of one account only")
      const cacheKey = names.join(",")
      const cached = tokens.get(cacheKey)
      if (cached !== undefined) {
        const token = await cached.catch(() => undefined)
        if (token !== undefined && token.expiresAt - REUSE_MARGIN_MS > now()) return token
      }
      const minted = (async () => {
        const installation = await installationOf(names[0]!)
        const created = await call<{ token: string; expires_at: string }>("POST", `/app/installations/${installation}/access_tokens`, {
          repositories: names.map((name) => name.split("/")[1]),
          permissions
        })
        return { token: created.token, expiresAt: Date.parse(created.expires_at) }
      })()
      tokens.set(cacheKey, minted)
      minted.catch(() => {
        if (tokens.get(cacheKey) === minted) tokens.delete(cacheKey)
      })
      return minted
    }
  }
}

export interface GithubAppTokensOptions {
  readonly name?: string
}

export const githubAppTokens = (app: GithubApp, options: GithubAppTokensOptions = {}) => {
  const secretName = options.name ?? "GITHUB_TOKEN"
  return async (session: Session, name: string): Promise<{ value: string; expiresAt: number } | undefined> => {
    if (name !== secretName) return undefined
    const bound = session.resolved?.repository
    if (bound === undefined || session.resolved?.untrusted === true) return undefined
    const issued = await app.installationToken([bound])
    return { value: issued.token, expiresAt: issued.expiresAt }
  }
}
