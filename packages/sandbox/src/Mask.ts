import type { Context } from "@earendil-works/chord"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"

/** Values shorter than this are not masked: they would match ordinary text. */
const MIN_LENGTH = 6

/**
 * Replaces known secret values with `[secret:NAME]`. Secrets are injected into sandboxes on purpose, but they must
 * not travel on into the transcript, the event stream, or the model's context, where a prompt injection could
 * extract them.
 */
export class SecretMask {
  private readonly secrets = new Map<string, string>()

  add(name: string, value: string): void {
    if (value.length >= MIN_LENGTH) this.secrets.set(value, name)
  }

  get size(): number {
    return this.secrets.size
  }

  text(input: string): string {
    let output = input
    for (const [value, name] of this.secrets) {
      if (output.includes(value)) output = output.split(value).join(`[secret:${name}]`)
    }
    return output
  }

  /** Mask every string inside a JSON-like value. */
  deep<T>(value: T): T {
    if (this.secrets.size === 0) return value
    if (typeof value === "string") return this.text(value) as T
    if (Array.isArray(value)) return value.map((item) => this.deep(item)) as T
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.deep(item)])) as T
    }
    return value
  }

  /**
   * Where `text` can be cut so that no secret straddles the cut and none can still be completed by what follows:
   * everything before the cut can be masked and sent, the rest is held for the next chunk.
   */
  private safeCut(text: string): number {
    let longest = 0
    for (const value of this.secrets.keys()) longest = Math.max(longest, value.length)
    let cut = Math.max(0, text.length - (longest - 1))
    for (let moved = true; moved;) {
      moved = false
      for (const value of this.secrets.keys()) {
        for (let at = text.indexOf(value, Math.max(0, cut - value.length + 1)); at !== -1 && at < cut; at = text.indexOf(value, at + 1)) {
          if (at + value.length > cut) {
            cut = at
            moved = true
          }
        }
      }
    }
    return cut
  }

  /**
   * Mask command output as it streams. Each stream holds back just enough of its tail that a secret split across
   * chunks is still masked whole, and sends the rest when the command ends, so streamed output (which clients see
   * and Pi may store as progress) never carries a secret either.
   */
  env(env: ExecutionEnv): ExecutionEnv {
    const masked = Object.create(env) as ExecutionEnv
    masked.exec = async (command, options, context) => {
      const onOutput = options?.onOutput
      if (onOutput === undefined) return env.exec(command, options, context)
      type Info = Parameters<typeof onOutput>[2]
      const held = new Map<Info["stream"], { text: string; context: Context; info: Info }>()
      const send = (text: string, outputContext: Context, info: Info) => {
        if (text !== "") onOutput(this.text(text), outputContext, info)
      }
      try {
        return await env.exec(command, {
          ...options,
          onOutput: (text, outputContext, info) => {
            // Output before an omission is omitted, held text included, on either stream.
            if (info.skipped !== undefined) held.clear()
            const combined = (held.get(info.stream)?.text ?? "") + text
            const cut = this.size === 0 ? combined.length : this.safeCut(combined)
            held.set(info.stream, { text: combined.slice(cut), context: outputContext, info: { stream: info.stream } as Info })
            send(combined.slice(0, cut), outputContext, info)
          }
        }, context)
      } finally {
        for (const { text, context: outputContext, info } of held.values()) send(text, outputContext, info)
      }
    }
    return masked
  }
}
