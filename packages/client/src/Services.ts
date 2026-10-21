import { createHost, type Host, type Ref, type WebSocketLike, webSocketLink } from "@earendil-works/chord"
import { ConversationObject, type Principal, principalKey, SessionObject, SessionsObject } from "@pi-cloud/protocol"
import { authorization } from "./auth.ts"
import type { ClientOptions } from "./index.ts"

/** A live connection to the service API (`Services.ts` in `@pi-cloud/protocol`). */
export interface ServiceConnection {
  /** The client's Chord host: `get` any object type, including ones runner plugins serve. */
  readonly host: Host<Principal>
  /** The session directory. */
  sessions(): Promise<Ref<typeof SessionsObject>>
  /** A session's conversations, models, tasks and notices, from the runner hosting it (woken if needed). */
  session(sessionId: string): Promise<Ref<typeof SessionObject>>
  /** One conversation of a session; the root by default. */
  conversation(sessionId: string, conversationId?: number): Promise<Ref<typeof ConversationObject>>
  close(): Promise<void>
}

/** A reference that outlives its object's host: see `follow`. */
export interface Followed<R> {
  /** The current reference. */
  readonly current: R
  /** Called with each new reference that replaces one that went away. */
  onChange(listener: (ref: R) => void): () => void
  release(): void
}

/**
 * Keep a reference to an object whose host may go away: a session's objects live on its runner, and a new runner
 * means new objects. When the reference is `gone`, `get` runs again (which wakes a new runner) until it succeeds.
 */
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

/**
 * Connect to the service API: a Chord link to the control plane's host over a WebSocket, reconnected when it drops.
 * References survive a reconnect (they re-hold and get their state again). A session's objects end with its runner:
 * `follow` keeps a reference across runners.
 */
export const connectServices = async (options: ClientOptions): Promise<ServiceConnection> => {
  const url = new URL("/v1/pi", options.url)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"

  const host = createHost<Principal>({ self: { kind: "client" }, principalKey, kind: "client" })
  let closing = false

  /** Open a socket and make it the host's upstream link; a dropped socket is replaced after a pause. */
  const open = () =>
    new Promise<void>((resolve, reject) => {
      // The key goes in the `Authorization` header (Node's and Bun's clients send it), never in the URL.
      const socket = new WebSocket(url, { headers: authorization(options.apiKey) } as never)
      socket.binaryType = "arraybuffer"
      let opened = false
      socket.addEventListener("open", () => {
        opened = true
        // The WHATWG socket, typed for ArrayBuffer-backed sends only.
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
