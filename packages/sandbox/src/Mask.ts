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

  /** Mask command output as it streams. A secret split across two chunks is caught by the final result mask. */
  env(env: ExecutionEnv): ExecutionEnv {
    const masked = Object.create(env) as ExecutionEnv
    masked.exec = (command, options, context) => {
      const onOutput = options?.onOutput
      return env.exec(
        command,
        onOutput === undefined
          ? options
          : { ...options, onOutput: (text, outputContext, info) => onOutput(this.text(text), outputContext, info) },
        context
      )
    }
    return masked
  }
}
