import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context"
import { type ExecutionEnv, FileError } from "@earendil-works/pi-durable/env"
import type { WorkspaceCall, WorkspaceEvent } from "@pi-cloud/protocol"
import { decode, encode, type Json } from "./Codec.ts"
import { isServed } from "./Methods.ts"

/** The client side of a workspace: runs calls against a local `ExecutionEnv`. Transport-agnostic. */
export interface WorkspaceServer {
  /** Run one call. `emit` receives its events and is last called with `End`. */
  call(id: string, call: WorkspaceCall, emit: (event: WorkspaceEvent) => void): void
  /** The caller gave up on a call: cancel it, or close the watcher it opened. */
  cancel(id: string): void
  /** Cancel everything, close open handles, and clean up the environment. */
  close(): Promise<void>
}

interface Handle {
  readonly value: Record<string, (...args: Array<unknown>) => Promise<unknown>>
  /** Ends the call that opened the handle, for handles that keep calling back (watchers). */
  end?: () => void
}

const unknownHandle = (method: string): Json =>
  encode({ ok: false, error: new FileError("invalid", `${method}: unknown handle (the workspace reconnected?)`) })

/**
 * Serve `env` (normally `NodeExecutionEnv` on the developer's checkout) to a remote runner. Readers and watchers
 * live here and are addressed by id; a watcher's call keeps streaming changes until it is closed or cancelled.
 */
export const serveWorkspace = (env: ExecutionEnv): WorkspaceServer => {
  const handles = new Map<string, Handle>()
  const running = new Map<string, { cancel: () => void; handle?: string }>()

  const closeHandle = async (id: string) => {
    const handle = handles.get(id)
    handles.delete(id)
    await handle?.value.close?.(BACKGROUND_CONTEXT)
    handle?.end?.()
  }

  const run = async (id: string, call: WorkspaceCall, emit: (event: WorkspaceEvent) => void) => {
    const { context, cancel } = withCancel(BACKGROUND_CONTEXT)
    const entry: { cancel: () => void; handle?: string } = { cancel }
    running.set(id, entry)
    let callbacks = false
    let opened: string | undefined
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      running.delete(id)
      emit({ _tag: "End" })
    }
    try {
      const target = call.target === undefined ? env : handles.get(call.target)?.value
      if (!isServed(call.method, call.target !== undefined)) {
        emit({ _tag: "Failed", message: `${call.method} is not a workspace method` })
        return end()
      }
      if (target === undefined) {
        emit({ _tag: "Done", value: unknownHandle(call.method) })
        return end()
      }
      const args = decode(call.args as Json, {
        context,
        callback: (callback) => {
          callbacks = true
          return (...values) => {
            if (!ended) emit({ _tag: "Callback", callback, args: encode(values) as Array<Json> })
          }
        }
      }) as Array<unknown>
      const method = (target as unknown as Record<string, (...args: Array<unknown>) => Promise<unknown>>)[call.method]!
      const result = call.target !== undefined && call.method === "close"
        ? await closeHandle(call.target)
        : await method.apply(target, args)
      const value = encode(result, {
        handle: (handle) => {
          opened = crypto.randomUUID()
          handles.set(opened, { value: handle as Handle["value"] })
          return opened
        }
      })
      emit({ _tag: "Done", value })
      // A watcher keeps reporting changes through this call until it is closed.
      if (callbacks && opened !== undefined && handles.has(opened)) {
        entry.handle = opened
        handles.get(opened)!.end = end
        return
      }
      end()
    } catch (error) {
      emit({ _tag: "Failed", message: error instanceof Error ? error.message : String(error) })
      end()
    }
  }

  return {
    call: (id, call, emit) => void run(id, call, emit),
    cancel: (id) => {
      const entry = running.get(id)
      if (entry === undefined) return
      entry.cancel()
      if (entry.handle !== undefined) void closeHandle(entry.handle)
    },
    close: async () => {
      for (const entry of running.values()) entry.cancel()
      await Promise.allSettled([...handles.keys()].map(closeHandle))
      await env.cleanup(BACKGROUND_CONTEXT)
    }
  }
}
