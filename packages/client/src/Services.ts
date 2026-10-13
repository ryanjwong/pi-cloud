import type { RemoteServiceBinding, Service } from "@earendil-works/chord"
import { createRemoteServiceBinding } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { Client, createClientServiceTransport } from "@earendil-works/pi-client"
import type { SessionTarget } from "@earendil-works/pi-protocol"
import { SERVER_SERVICES, SESSION_SERVICES, SessionManagement } from "@pi-cloud/protocol"
import type { ClientOptions } from "./index.ts"

/** A live connection to the service API (`Services.ts` in `@pi-cloud/protocol`). */
export interface ServiceConnection {
  /** Pi's protocol client; for anything the helpers below do not cover. */
  readonly client: Client
  /** The server services: the session directory and management, and pi-cloud's sessions. */
  readonly server: RemoteServiceBinding
  /**
   * Attach to a session and bind its services (and `extra` ones a runner plugin serves). The attachment survives
   * the session's runner changing: the binding re-subscribes on the new runner.
   */
  attach(sessionId: string, extra?: ReadonlyArray<Service<unknown>>): Promise<AttachedSession>
  close(): Promise<void>
}

export interface AttachedSession {
  readonly sessionId: string
  readonly services: RemoteServiceBinding
  detach(): Promise<void>
}

/** Pi's byte transport over a WebSocket: binary frames carry the protocol's framed CBOR messages. */
const webSocketTransport = (url: string) => (handlers: Parameters<ConstructorParameters<typeof Client>[0]["transportFactory"]>[0]) =>
  new Promise<{ send(chunk: Uint8Array): Promise<void>; close(): void }>((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.binaryType = "arraybuffer"
    let open = false
    socket.onopen = () => {
      open = true
      resolve({
        send: async (chunk) => socket.send(chunk as Uint8Array<ArrayBuffer>),
        close: () => socket.close()
      })
    }
    socket.onmessage = (event) => {
      const data = event.data
      handlers.onData(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer))
    }
    socket.onerror = () => {
      if (!open) reject(new Error(`Cannot connect to ${url}`))
      else handlers.onError(new Error("WebSocket error"))
    }
    socket.onclose = () => {
      if (open) handlers.onClose()
    }
  })

/**
 * Connect to the service API with Pi's own client (`@earendil-works/pi-client`). Presentations bind Chord services
 * from here: `connection.server.use(CloudSessions).state`, `(await connection.attach(id)).services.use(Transcript)`.
 */
export const connectServices = async (options: ClientOptions): Promise<ServiceConnection> => {
  const headers: Record<string, string> = options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }
  const info = await fetch(new URL("/v1/server", options.url), { headers }).then((response) => {
    if (!response.ok) throw new Error(`GET /v1/server: ${response.status}`)
    return response.json() as Promise<{ serverId: string; servicesPath: string }>
  })
  const url = new URL(info.servicesPath, options.url)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  if (options.apiKey !== undefined) url.searchParams.set("token", options.apiKey)
  const client = await Client.connect({ serverId: info.serverId, transportFactory: webSocketTransport(url.toString()) })
  const server = createRemoteServiceBinding({
    services: SERVER_SERVICES,
    transport: createClientServiceTransport(client, () => ({ serverId: info.serverId }))
  })

  const attach = async (sessionId: string, extra: ReadonlyArray<Service<unknown>> = []): Promise<AttachedSession> => {
    const management = server.use(SessionManagement)
    let wanted = true
    let attachment: SessionTarget | undefined
    const attached = () => attachment !== undefined && attachment.sessionId === sessionId
    const services = createRemoteServiceBinding({
      services: [...SESSION_SERVICES, ...extra],
      transport: createClientServiceTransport(client, () => attachment),
      bound: false
    })
    let waiting: (() => void) | undefined
    let transition = Promise.resolve()
    // The server publishes the live route out of band; it clears it when the session's runner stops.
    const unsubscribe = client.onAttachmentChange((next) => {
      attachment = next
      if (attached()) waiting?.()
      transition = transition.then(async () => {
        if (attached()) await services.rebind(true, BACKGROUND_CONTEXT)
        else {
          await services.rebind(false, BACKGROUND_CONTEXT)
          if (wanted) await management.attach(sessionId, BACKGROUND_CONTEXT).catch(() => {})
        }
      }).catch(() => {})
    })
    const ready = new Promise<void>((resolve) => (waiting = resolve))
    await management.attach(sessionId, BACKGROUND_CONTEXT)
    if (!attached()) await ready
    await transition
    return {
      sessionId,
      services,
      detach: async () => {
        wanted = false
        unsubscribe()
        await services.dispose(BACKGROUND_CONTEXT)
        await management.detach(BACKGROUND_CONTEXT).catch(() => {})
      }
    }
  }

  return {
    client,
    server,
    attach,
    close: async () => {
      await server.dispose(BACKGROUND_CONTEXT).catch(() => {})
      await client.dispose()
    }
  }
}

