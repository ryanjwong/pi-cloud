import type { AssistantMessage } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { applyChanges } from "../src/Message.ts"

const empty = { role: "assistant", content: [], stopReason: "stop" } as unknown as AssistantMessage

describe("applyChanges", () => {
  it("builds text, thinking and tool calls from streamed changes", () => {
    const message = applyChanges(empty, [
      { type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } as never },
      { type: "thinking_delta", contentIndex: 0, delta: "Let me " },
      { type: "thinking_delta", contentIndex: 0, delta: "look." },
      { type: "text_start", contentIndex: 1, block: { type: "text", text: "Hel" } as never },
      { type: "text_delta", contentIndex: 1, delta: "lo" },
      { type: "toolcall_start", contentIndex: 2, block: { type: "toolCall", id: "t1", name: "bash", arguments: {} } as never },
      { type: "toolcall_delta", contentIndex: 2, path: ["command"], delta: "ls " },
      { type: "toolcall_delta", contentIndex: 2, path: ["command"], delta: "-la" }
    ])
    expect(message.content).toEqual([
      { type: "thinking", thinking: "Let me look." },
      { type: "text", text: "Hello" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls -la" } }
    ])
    expect(empty.content).toEqual([])
  })

  it("replaces blocks and whole messages", () => {
    const first = applyChanges(empty, [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "draft" } as never }])
    const block = applyChanges(first, [{ type: "block", contentIndex: 0, block: { type: "text", text: "final" } as never }])
    expect(block.content).toEqual([{ type: "text", text: "final" }])
    const whole = { ...empty, content: [{ type: "text", text: "whole" }] } as unknown as AssistantMessage
    expect(applyChanges(block, [{ type: "message", message: whole }]).content).toEqual([{ type: "text", text: "whole" }])
  })

  it("streams nested tool arguments", () => {
    const start = applyChanges(empty, [
      { type: "toolcall_start", contentIndex: 0, block: { type: "toolCall", id: "t", name: "edit", arguments: {} } as never },
      { type: "toolcall_delta", contentIndex: 0, path: ["edits", 0, "oldText"], delta: "a" },
      { type: "toolcall_delta", contentIndex: 0, path: ["edits", 0, "oldText"], delta: "b" }
    ])
    expect((start.content[0] as any).arguments).toEqual({ edits: [{ oldText: "ab" }] })
  })
})
