import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai"

export interface CredentialTransport {
  get(providerId: string): Promise<{ readonly credential?: Credential | undefined; readonly version: number }>
  list(): Promise<ReadonlyArray<CredentialInfo>>
  put(providerId: string, version: number, credential: Credential): Promise<{ readonly stored: boolean; readonly version: number }>
}

export class RemoteCredentialStore implements CredentialStore {
  readonly #transport: CredentialTransport
  readonly #chains = new Map<string, Promise<unknown>>()

  constructor(transport: CredentialTransport) {
    this.#transport = transport
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.#transport.get(providerId)).credential
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
    const result = (this.#chains.get(providerId) ?? Promise.resolve()).then(run, run)
    this.#chains.set(providerId, result.catch(() => {}))
    return result
  }

  async delete(): Promise<void> {
    throw new Error("Credentials are managed through the control plane (pi-cloud logout)")
  }
}
