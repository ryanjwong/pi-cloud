import type { Context } from "@earendil-works/chord"
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env"

/**
 * The JSON encoding of `ExecutionEnv` arguments and results. Plain data stays as it is; everything else becomes a
 * tagged object:
 *
 * - `{ $bytes }`: a `Uint8Array`, base64.
 * - `{ $error, code, message, path?, spillPath? }`: a `FileError`, `ExecutionError`, or other error.
 * - `{ $handle, props }`: an object with a `close` method (line, binary and directory readers, watchers). It
 *   stays on the side that created it; the other side calls its methods by id.
 * - `{ $callback }`: a function argument (`exec`'s `onOutput`, `watch`'s `onChange`), invoked by id.
 * - `{ $context }`: a Pi `Context`. Each side substitutes its own: contexts carry cancellation, which travels
 *   separately.
 *
 * `undefined` travels as `null`; no `ExecutionEnv` value is legitimately `null`.
 */
export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

export interface Encoder {
  readonly handle?: (value: { close: unknown }) => string
  readonly callback?: (fn: (...args: Array<unknown>) => unknown) => number
}

export interface Decoder {
  readonly handle?: (id: string, props: Record<string, unknown>) => unknown
  readonly callback?: (id: number) => (...args: Array<unknown>) => void
  readonly context: Context
}

const isContext = (value: object): value is Context =>
  "abortSignal" in value && typeof (value as { value?: unknown }).value === "function"

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")

export const encode = (value: unknown, encoder: Encoder = {}): Json => {
  if (value === undefined || value === null) return null
  if (typeof value === "function") {
    if (encoder.callback === undefined) throw new Error("Callbacks cannot be sent in this direction")
    return { $callback: encoder.callback(value as (...args: Array<unknown>) => unknown) }
  }
  if (typeof value !== "object") return value as Json
  if (value instanceof Uint8Array) return { $bytes: toBase64(value) }
  if (value instanceof Error) {
    const { code, path, spillPath } = value as Partial<FileError & ExecutionError>
    const kind = value instanceof FileError ? "FileError" : value instanceof ExecutionError ? "ExecutionError" : "Error"
    return { $error: kind, message: value.message, ...strip({ code, path, spillPath }) }
  }
  if (Array.isArray(value)) return value.map((item) => encode(item, encoder))
  if (isContext(value)) return { $context: true }
  if (typeof (value as { close?: unknown }).close === "function") {
    if (encoder.handle === undefined) throw new Error("Handles cannot be sent in this direction")
    const props: Record<string, Json> = {}
    for (const key of [...Object.keys(value), "mode"]) {
      const prop = (value as Record<string, unknown>)[key]
      if (prop !== undefined && typeof prop !== "function") props[key] = encode(prop, encoder)
    }
    return { $handle: encoder.handle(value as { close: unknown }), props }
  }
  const result: Record<string, Json> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = encode(item, encoder)
  }
  return result
}

const strip = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Record<string, Json>

export const decode = (value: Json, decoder: Decoder): any => {
  if (value === null) return undefined
  if (typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => decode(item, decoder))
  const tagged = value as Record<string, any>
  if (typeof tagged.$bytes === "string") return new Uint8Array(Buffer.from(tagged.$bytes, "base64"))
  if (typeof tagged.$error === "string") {
    if (tagged.$error === "FileError") return new FileError(tagged.code ?? "unknown", tagged.message, tagged.path)
    if (tagged.$error === "ExecutionError") {
      const error = new ExecutionError(tagged.code ?? "unknown", tagged.message)
      if (tagged.spillPath !== undefined) error.spillPath = tagged.spillPath
      return error
    }
    return new Error(tagged.message)
  }
  if (tagged.$context === true) return decoder.context
  if (typeof tagged.$callback === "number") {
    if (decoder.callback === undefined) throw new Error("Unexpected callback")
    return decoder.callback(tagged.$callback)
  }
  if (typeof tagged.$handle === "string") {
    if (decoder.handle === undefined) throw new Error("Unexpected handle")
    return decoder.handle(tagged.$handle, decode(tagged.props ?? {}, decoder))
  }
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(tagged)) {
    const decoded = decode(item, decoder)
    if (decoded !== undefined) result[key] = decoded
  }
  return result
}
