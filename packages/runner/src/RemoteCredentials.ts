import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai"

export interface CredentialTransport {
  get(providerId: string): Promise<{ readonly credential?: Credential | undefined; readonly version: number }>
  list(): Promise<ReadonlyArray<CredentialInfo>>
  put(providerId: string, version: number, credential: Credential): Promise<{ readonly stored: boolean; readonly version: number }>
}

const FRESH_MS = 30_000
const REFRESH_MARGIN_MS = 2 * 60_000

interface Cached {
  readonly credential: Promise<Credential | undefined>
  until: number
}

export class RemoteCredentialStore implements CredentialStore {
  readonly #transport: CredentialTransport
  readonly #chains = new Map<string, Promise<unknown>>()
  readonly #cache = new Map<string, Cached>()

  constructor(transport: CredentialTransport) {
    this.#transport = transport
  }

  read(providerId: string): Promise<Credential | undefined> {
    const cached = this.#cache.get(providerId)
    if (cached !== undefined && cached.until > Date.now()) return cached.credential
    const cell: Cached = { credential: this.#transport.get(providerId).then(({ credential }) => credential), until: Infinity }
    this.#cache.set(providerId, cell)
    const evict = () => {
      if (this.#cache.get(providerId) === cell) this.#cache.delete(providerId)
    }
    cell.credential.then((credential) => {
      if (credential === undefined) return evict()
      cell.until = Math.min(Date.now() + FRESH_MS, credential.type === "oauth" ? credential.expires - REFRESH_MARGIN_MS : Infinity)
    }, evict)
    return cell.credential
  }

  list(): Promise<ReadonlyArray<CredentialInfo>> {
    return this.#transport.list()
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    const run = async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const { credential, version } = await this.#transport.get(providerId)
        const next = await fn(credential)
        if (next === undefined || JSON.stringify(next) === JSON.stringify(credential)) return next
        if ((await this.#transport.put(providerId, version, next)).stored) return next
      }
      throw new Error(`Could not update the ${providerId} credential: it keeps changing`)
    }
    const result = (this.#chains.get(providerId) ?? Promise.resolve()).then(run, run).finally(() => this.#cache.delete(providerId))
    this.#chains.set(providerId, result.catch(() => {}))
    return result
  }

  async delete(): Promise<void> {
    throw new Error("Credentials are managed through the control plane (pi-cloud logout)")
  }
}
