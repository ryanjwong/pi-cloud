import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent
} from "@earendil-works/pi-coding-agent"
import type { AgentEvent, AgentState, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable"
import type { UsageState } from "@earendil-works/pi-durable"
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui"
import { applyChanges } from "./Message.ts"

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`
const red = (text: string) => `\x1b[31m${text}\x1b[39m`

type ToolResultMessage = Extract<Message, { role: "toolResult" }>

/** What the footer shows, derived from the session's events. */
export interface ChatState {
  readonly running: boolean
  readonly agent?: AgentState | undefined
  readonly usage?: UsageState | undefined
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
    ? content.filter((block) => block?.type === "text").map((block) => block.text).join("")
    : ""

/**
 * The conversation, rendered with Pi's own components (the ones `pi` uses locally) from Pi Durable's event stream:
 * a snapshot rebuilds it, then message and tool events stream into it.
 */
export class ChatView {
  readonly container = new Container()
  private streaming: { component: AssistantMessageComponent; message: AssistantMessage } | undefined
  private readonly tools = new Map<string, { component: ToolExecutionComponent; output: string }>()
  private readonly definitions: Record<string, unknown>
  private state: ChatState = { running: false }

  private readonly ui: TUI
  private readonly cwd: string
  private readonly onState: (state: ChatState) => void

  constructor(ui: TUI, cwd: string, onState: (state: ChatState) => void = () => {}) {
    this.ui = ui
    this.cwd = cwd
    this.onState = onState
    // Pi's tool definitions carry its renderers (diffs for edits, shell output, file previews). Only rendering is
    // used here; the tools themselves run in the session.
    this.definitions = {
      bash: createBashToolDefinition(cwd),
      read: createReadToolDefinition(cwd),
      edit: createEditToolDefinition(cwd),
      write: createWriteToolDefinition(cwd),
      grep: createGrepToolDefinition(cwd),
      find: createFindToolDefinition(cwd),
      ls: createLsToolDefinition(cwd)
    }
  }

  private setState(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch }
    this.onState(this.state)
  }

  private add(component: { render(width: number): Array<string> }) {
    this.container.addChild(component as never)
  }

  /** A line of status or error text in the conversation. */
  notice(text: string, kind: "info" | "error" = "info") {
    this.add(new Text(kind === "error" ? red(text) : dim(text), 1, 0))
    this.ui.requestRender()
  }

  private user(content: unknown) {
    const text = textOf(content)
    if (text.length === 0) return
    this.add(new Spacer(1))
    this.add(new UserMessageComponent(text, getMarkdownTheme()))
  }

  private tool(id: string, name: string, args: unknown) {
    let tool = this.tools.get(id)
    if (tool === undefined) {
      const component = new ToolExecutionComponent(name, id, args, undefined, this.definitions[name] as never, this.ui, this.cwd)
      this.add(component)
      tool = { component, output: "" }
      this.tools.set(id, tool)
    } else tool.component.updateArgs(args)
    return tool
  }

  private toolCalls(message: AssistantMessage, complete: boolean) {
    for (const block of message.content) {
      if (block.type !== "toolCall") continue
      const tool = this.tool(block.id, block.name, block.arguments)
      if (complete) tool.component.setArgsComplete()
    }
  }

  private result(message: ToolResultMessage) {
    const tool = this.tools.get(message.toolCallId)
    if (tool === undefined) return
    tool.component.updateResult({ content: message.content, details: message.details, isError: message.isError } as never)
    this.tools.delete(message.toolCallId)
  }

  private entry(entry: EntryRecord) {
    const message = entry.model?.[0]
    switch (entry.kind) {
      case "pi.user":
        return this.user(message?.content)
      case "pi.assistant": {
        if (message?.role !== "assistant") return
        this.add(new AssistantMessageComponent(message, false, getMarkdownTheme()))
        return this.toolCalls(message, true)
      }
      case "pi.tool-result":
        if (message?.role === "toolResult") this.result(message)
        return
      case "pi.compaction":
        return this.notice("(earlier conversation compacted)")
      case "pi.reset":
        return this.notice("(conversation reset)")
    }
  }

  private snapshot(event: SnapshotEvent) {
    this.container.clear()
    this.tools.clear()
    this.streaming = undefined
    for (const entry of event.entries) this.entry(entry)
    const partial = event.generation?.message
    if (partial !== undefined) this.startStreaming(partial)
    for (const slot of event.tools) {
      if (slot.status === "done") continue
      const tool = this.tools.get(slot.callId)
      if (tool === undefined) continue
      tool.component.markExecutionStarted()
      if (slot.output !== undefined) {
        tool.output = slot.output
        tool.component.updateResult({ content: [{ type: "text", text: slot.output }], details: slot.details, isError: false } as never, true)
      }
    }
    this.setState({ running: event.run !== undefined, agent: event.agent, usage: event.usage })
  }

  private startStreaming(message: AssistantMessage) {
    const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme())
    this.add(component)
    component.updateContent(message, true)
    this.streaming = { component, message }
    this.toolCalls(message, false)
  }

  apply(event: AgentEvent) {
    switch (event.type) {
      case "snapshot":
        this.snapshot(event)
        break
      case "run_start":
        this.setState({ running: true })
        break
      case "run_end":
        this.setState({ running: false })
        break
      case "message_start":
        if (event.message.role === "user") this.user(event.message.content)
        else if (event.message.role === "assistant") this.startStreaming(event.message)
        break
      case "message_update": {
        const streaming = this.streaming
        if (streaming === undefined) break
        streaming.message = applyChanges(streaming.message, event.changes)
        streaming.component.updateContent(streaming.message, true)
        this.toolCalls(streaming.message, false)
        break
      }
      case "message_end": {
        const message = event.entry.model?.[0]
        if (event.entry.kind === "pi.assistant" && message?.role === "assistant") {
          if (this.streaming === undefined) this.add(new AssistantMessageComponent(message, false, getMarkdownTheme()))
          else this.streaming.component.updateContent(message, false)
          this.toolCalls(message, true)
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            const text = message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage ?? "Error"
            for (const [id, tool] of this.tools) {
              tool.component.updateResult({ content: [{ type: "text", text }], isError: true } as never)
              this.tools.delete(id)
            }
          }
        } else if (this.streaming === undefined && event.entry.kind !== "pi.user") {
          // User messages were shown at `message_start`.
          this.entry(event.entry)
        }
        this.streaming = undefined
        break
      }
      case "tool_execution_start":
        this.tool(event.toolCallId, event.toolName, event.args).component.markExecutionStarted()
        break
      case "tool_execution_update": {
        const tool = this.tools.get(event.toolCallId)
        if (tool === undefined) break
        const output = event.output
        if (output !== undefined) {
          if ("set" in output) tool.output = output.set
          else tool.output = tool.output.slice(output.trimStart ?? 0) + (output.append ?? "")
        }
        tool.component.updateResult(
          { content: [{ type: "text", text: tool.output }], details: event.details, isError: false } as never,
          true
        )
        break
      }
      case "tool_execution_end": {
        const message = event.entry?.model?.[0]
        if (message?.role === "toolResult") this.result(message)
        break
      }
      case "agent_changed":
        this.setState({ agent: event.agent })
        break
      case "usage_changed":
        this.setState({ usage: event.usage })
        break
      case "auto_retry_start":
        this.notice(`Retrying (attempt ${event.attempt}): ${event.errorMessage}`)
        break
      case "task_failed":
        this.notice(`${event.kind} failed: ${event.message}`, "error")
        break
      case "compaction_start":
        this.notice("Compacting conversation…")
        break
      default:
        return
    }
    this.ui.requestRender()
  }
}
