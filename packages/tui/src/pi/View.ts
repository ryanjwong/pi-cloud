// The view contract of Pi's durable TUI, from Pi (github.com/earendil-works/pi, v1.1.0),
// packages/coding-agent/src/experimental/durable/runtime.ts. MIT License, Copyright (c) 2025 Mario Zechner.
import type { AgentState, ConversationId, ConversationView, ModelRef, TaskGraph } from "@earendil-works/pi-durable"

export interface ModelSummary {
  readonly provider: string
  readonly modelId: string
  readonly name: string
  readonly contextWindow: number
}

export interface Notice {
  readonly id: number
  readonly level: "info" | "warning" | "error"
  readonly message: string
}

/** A conversation the user can switch to: the main one, or a subagent's. */
export interface ConversationSummary {
  readonly id: ConversationId
  readonly label: string
  /** The first user message, for a subagent its task. */
  readonly title?: string
}

/** Everything the TUI renders. Plain values; no Harness objects cross this boundary. */
export interface DurableView {
  readonly session: { readonly id: string; readonly directory: string; readonly cwd: string }
  /** The conversation shown and talked to. */
  readonly conversation: ConversationView
  readonly conversations: ReadonlyArray<ConversationSummary>
  readonly models: ReadonlyArray<ModelSummary>
  readonly notices: ReadonlyArray<Notice>
  /** The live task graph while the task panel is open. */
  readonly tasks?: TaskGraph
}

export interface DurableViewSource {
  current(): DurableView
  subscribe(listener: () => void): () => void
}

/** What the TUI may ask for. */
export interface DurableController {
  /** Prompt when idle; otherwise steer or queue a follow-up. */
  submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>
  compact(instructions: string | undefined): Promise<void>
  abort(): Promise<void>
  cycleThinking(): Promise<void>
  setModel(model: ModelRef): Promise<void>
  toggleTasks(): Promise<void>
  /** Show and talk to another conversation. */
  switchConversation(id: ConversationId): Promise<void>
}

/** The agent document of a view; absent while the conversation has none. */
export function agentOf(view: ConversationView): AgentState {
  return (view.docs["pi.agent"] ?? {}) as AgentState
}
