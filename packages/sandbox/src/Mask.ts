import type { Context } from "@earendil-works/chord"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"

const MIN_LENGTH = 6

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

  deep<T>(value: T): T {
    if (this.secrets.size === 0) return value
    if (typeof value === "string") return this.text(value) as T
    if (Array.isArray(value)) return value.map((item) => this.deep(item)) as T
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.deep(item)])) as T
    }
    return value
  }

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
