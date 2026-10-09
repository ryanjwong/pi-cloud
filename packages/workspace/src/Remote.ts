import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { type ExecutionEnv, ExecutionError, FileError } from "@earendil-works/pi-durable/env"
import type { WorkspaceCall, WorkspaceEvent } from "@pi-cloud/protocol"
import { decode, encode, type Json } from "./Codec.ts"
import { ENV_METHODS, HANDLE_METHODS } from "./Methods.ts"

/**
 * Sends one call to wherever the workspace is served and reports its events until the call ends. Rejects when
 * the workspace is unreachable; aborting `signal` cancels the call there.
 */
export type WorkspaceTransport = (
  call: WorkspaceCall,
  onEvent: (event: WorkspaceEvent) => void,
  signal: AbortSignal | undefined
) => Promise<void>

const isContext = (value: unknown): value is Context =>
  typeof value === "object" && value !== null && "abortSignal" in value

/** Methods that resolve to `Result`s; a transport failure becomes their error result rather than a throw. */
const failure = (method: string, message: string, aborted: boolean) => {
  if (method === "close" || method === "cleanup") return undefined
  const error = method === "exec"
    ? new ExecutionError(aborted ? "aborted" : "unknown", message)
    : new FileError(aborted ? "aborted" : "unknown", message)
  return { ok: false, error }
}

/**
 * An `ExecutionEnv` whose every operation runs in a workspace served elsewhere (by `serveWorkspace`), so Pi's tools
 * behave exactly as they do on that machine.
 */
export const remoteEnv = (transport: WorkspaceTransport, options: { readonly cwd: string; readonly id?: string }): ExecutionEnv => {
  const invoke = (target: string | undefined, method: string, args: Array<unknown>): Promise<any> => {
    const callbacks: Array<(...args: Array<unknown>) => unknown> = []
    const context = args.find(isContext) ?? BACKGROUND_CONTEXT
    const encoded = encode(args, { callback: (fn) => callbacks.push(fn) - 1 }) as Array<Json>
    const decoder = { context, handle: (id: string, props: Record<string, unknown>) => handle(id, props) }
    return new Promise((resolve) => {
      let settled = false
      const settle = (value: unknown) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      transport({ method, ...(target === undefined ? {} : { target }), args: encoded }, (event) => {
        switch (event._tag) {
          case "Callback":
            try {
              callbacks[event.callback]?.(...(decode(event.args as Json, decoder) as Array<unknown>))
            } catch {
              // A failing callback must not break the call.
            }
            return
          case "Done":
            return settle(decode(event.value as Json, decoder))
          case "Failed":
            return settle(failure(method, event.message, false))
        }
      }, context.abortSignal).then(
        () => settle(failure(method, `${method} ended without a result`, false)),
        (error) =>
          settle(failure(method, error instanceof Error ? error.message : String(error?.message ?? error), context.abortSignal?.aborted === true))
      )
    })
  }

  const handle = (id: string, props: Record<string, unknown>) => {
    const value: Record<string, unknown> = { ...props }
    for (const method of HANDLE_METHODS) value[method] = (...args: Array<unknown>) => invoke(id, method, args)
    return value
  }

  const env: Record<string, unknown> = {
    id: options.id ?? "workspace",
    cwd: options.cwd,
    // The serving client owns its processes and temporary files and cleans them up when it goes away.
    cleanup: async () => {}
  }
  for (const method of ENV_METHODS) env[method] = (...args: Array<unknown>) => invoke(undefined, method, args)
  return env as unknown as ExecutionEnv
}
