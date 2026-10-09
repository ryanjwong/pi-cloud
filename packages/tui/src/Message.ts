import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { MessageChange } from "@earendil-works/pi-durable"

type Block = AssistantMessage["content"][number]

const appendAt = (target: Record<string, unknown>, path: ReadonlyArray<string | number>, delta: string) => {
  let node: any = target
  for (const [index, key] of path.entries()) {
    if (index === path.length - 1) {
      node[key] = `${typeof node[key] === "string" ? node[key] : ""}${delta}`
      return
    }
    node[key] ??= typeof path[index + 1] === "number" ? [] : {}
    node = node[key]
  }
}

/**
 * Applies Pi Durable's streamed `message_update` changes to the assistant message being generated, so it can be
 * rendered as a whole message (which is what Pi's components take). Returns a new message.
 */
export const applyChanges = (message: AssistantMessage, changes: ReadonlyArray<MessageChange>): AssistantMessage => {
  let current: AssistantMessage = { ...message, content: [...message.content] }
  for (const change of changes) {
    switch (change.type) {
      case "message":
        current = { ...change.message, content: [...change.message.content] }
        break
      case "text_start":
      case "thinking_start":
      case "toolcall_start":
      case "block":
        current.content[change.contentIndex] = structuredClone(change.block) as Block
        break
      case "text_delta": {
        const block = current.content[change.contentIndex] as { type: "text"; text: string } | undefined
        current.content[change.contentIndex] = { ...block, type: "text", text: `${block?.text ?? ""}${change.delta}` } as Block
        break
      }
      case "thinking_delta": {
        const block = current.content[change.contentIndex] as { type: "thinking"; thinking: string } | undefined
        current.content[change.contentIndex] = {
          ...block,
          type: "thinking",
          thinking: `${block?.thinking ?? ""}${change.delta}`
        } as Block
        break
      }
      case "toolcall_delta": {
        const block = structuredClone(current.content[change.contentIndex] ?? { type: "toolCall", arguments: {} }) as Record<string, unknown>
        // The path is within the call's arguments, which stream as they are parsed.
        block.arguments ??= {}
        appendAt(block.arguments as Record<string, unknown>, change.path, change.delta)
        current.content[change.contentIndex] = block as unknown as Block
        break
      }
    }
  }
  return current
}
