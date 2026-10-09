import { entryText, textOf } from "@pi-cloud/client"

type Event = { readonly type: string; readonly [key: string]: unknown }

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`

/**
 * Renders Pi agent events as terminal text. A projection like this is all a client needs: every surface (TUI,
 * web, Slack) is a different renderer over the same event stream.
 *
 * Fast generations may arrive whole (in `message_start` or a final `message` change) rather than as deltas, so
 * the renderer tracks what it already printed of the current assistant message and prints only the rest.
 */
export const makeRenderer = (write: (text: string) => void) => {
  let printed: string | undefined

  const catchUp = (message: { readonly content?: ReadonlyArray<unknown> } | undefined) => {
    if (printed === undefined) return
    const text = textOf(message)
    if (text.startsWith(printed) && text.length > printed.length) {
      write(text.slice(printed.length))
      printed = text
    }
  }

  return (event: Event): void => {
    switch (event.type) {
      case "snapshot": {
        for (const entry of (event.entries as ReadonlyArray<{ kind: string }>) ?? []) {
          if (entry.kind === "pi.user") write(`${cyan("you")} ${entryText(entry as never)}\n`)
          if (entry.kind === "pi.assistant") {
            const text = entryText(entry as never)
            if (text) write(`${cyan("pi")}  ${text}\n`)
          }
        }
        return
      }
      case "message_start": {
        const message = event.message as { role?: string; content?: ReadonlyArray<unknown> } | undefined
        if (message?.role !== "assistant") return
        write(`${cyan("pi")}  `)
        printed = ""
        return catchUp(message)
      }
      case "message_update": {
        if (printed === undefined) return
        for (const change of (event.changes as ReadonlyArray<{ type: string; delta?: string; message?: never }>) ?? []) {
          if (change.type === "text_delta" && change.delta) {
            write(change.delta)
            printed += change.delta
          }
          if (change.type === "thinking_delta" && change.delta) write(dim(change.delta))
          if (change.type === "message") catchUp(change.message)
        }
        return
      }
      case "message_end": {
        if (printed === undefined) return
        catchUp((event.entry as { model?: ReadonlyArray<never> } | undefined)?.model?.[0])
        printed = undefined
        return write("\n")
      }
      case "tool_execution_start":
        return write(dim(`  ↳ ${event.toolName} ${JSON.stringify(event.args)}\n`))
      case "tool_execution_end":
        return write(dim(`  ✓ ${event.toolName}\n`))
      case "auto_retry_start":
        return write(dim(`  retrying: ${event.errorMessage}\n`))
      case "task_failed":
        return write(`  ✗ ${event.kind}: ${event.message}\n`)
      default:
        return
    }
  }
}
