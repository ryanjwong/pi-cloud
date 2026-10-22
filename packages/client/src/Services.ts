import { createHost, type Host, type Ref, type WebSocketLike, webSocketLink } from "@earendil-works/chord"
import { ConversationObject, type Principal, principalKey, SessionObject, SessionsObject } from "@pi-cloud/protocol"
import { authorization } from "./auth.ts"
import type { ClientOptions } from "./index.ts"

export interface ServiceConnection {
  readonly host: Host<Principal>
  sessions(): Promise<Ref<typeof SessionsObject>>
  session(sessionId: string): Promise<Ref<typeof SessionObject>>
  conversation(sessionId: string, conversationId?: number): Promise<Ref<typeof ConversationObject>>
  close(): Promise<void>
}

export interface Followed<R> {
  readonly current: R
  onChange(listener: (ref: R) => void): () => void
  release(): void
}

export const follow = async <R extends { onStatus: Ref<any>["onStatus"]; release(): void }>(get: () => Promise<R>): Promise<Followed<R>> => {
  let current = await get()
  let released = false
  const listeners = new Set<(ref: R) => void>()
  const watch = (ref: R) =>
    ref.onStatus((status) => {
      if (status !== "gone" || released || ref !== current) return
      void (async () => {
        for (let delay = 200; !released; delay = Math.min(delay * 2, 5_000)) {
          try {
            const next = await get()
            if (released) return next.release()
            current = next
            watch(next)
            for (const listener of listeners) listener(next)
            return
          } catch {
            await new Promise((resolve) => setTimeout(resolve, delay))
          }
        }
      })()
    })
  watch(current)
  return {
    get current() {
      return current
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    release: () => {
      released = true
      current.release()
    }
  }
}

export const connectServices = async (options: ClientOptions): Promise<ServiceConnection> => {
  const url = new URL("/v1/pi", options.url)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"

  const host = createHost<Principal>({ self: { kind: "client" }, principalKey, kind: "client" })
  let closing = false

  const open = () =>
    new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: authorization(options.apiKey) } as never)
      socket.binaryType = "arraybuffer"
      let opened = false
      socket.addEventListener("open", () => {
        opened = true
        host.connect(webSocketLink(socket as unknown as WebSocketLike), { principal: { kind: "server" } })
        resolve()
      })
      socket.addEventListener("close", () => {
        if (!opened) reject(new Error(`Cannot connect to ${url.origin}${url.pathname}`))
        else if (!closing) setTimeout(() => void reconnect(), 500)
      })
    })
  const reconnect = async (): Promise<void> => {
    for (let delay = 500; !closing; delay = Math.min(delay * 2, 10_000)) {
      try {
        return await open()
      } catch {
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
  await open()

  return {
    host,
    sessions: () => host.get(SessionsObject, {}),
    session: (sessionId) => host.get(SessionObject, { session: sessionId }),
    conversation: (sessionId, conversationId) =>
      host.get(ConversationObject, { session: sessionId, ...(conversationId === undefined ? {} : { conversation: conversationId }) }),
    close: async () => {
      closing = true
      await host.close()
    }
  }
}
