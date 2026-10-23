import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import type { Models } from "@earendil-works/pi-ai/models"

export interface Streamed {
  message: AssistantMessage | undefined
  ended: boolean
}

export interface LiveStreams {
  get(providerSessionId: string): Streamed | undefined
  subscribe(listener: (providerSessionId: string) => void): () => void
}

export const liveStreams = (models: Models): LiveStreams => {
  const streams = new Map<string, Streamed>()
  const listeners = new Set<(providerSessionId: string) => void>()
  const stream = models.streamSimple.bind(models)
  models.completeSimple = (model, context, options) => stream(model, context, options).result()
  models.streamSimple = (model, context, options) => {
    const source = stream(model, context, options)
    const id = options?.sessionId
    if (id === undefined) return source
    const streamed: Streamed = { message: undefined, ended: false }
    streams.set(id, streamed)
    const tapped = createAssistantMessageEventStream()
    void (async () => {
      try {
        for await (const event of source) {
          if (event.type !== "done" && event.type !== "error" && event.partial.content.length > 0) streamed.message = event.partial
          tapped.push(event)
          for (const listener of listeners) listener(id)
        }
      } finally {
        streamed.ended = true
        tapped.end(await source.result())
      }
    })()
    return tapped
  }
  return {
    get: (id) => streams.get(id),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
}
