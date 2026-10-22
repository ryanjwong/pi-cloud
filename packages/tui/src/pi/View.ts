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

export interface ConversationSummary {
  readonly id: ConversationId
  readonly label: string
  readonly title?: string
}

export interface DurableView {
  readonly session: { readonly id: string; readonly directory: string; readonly cwd: string }
  readonly conversation: ConversationView
  readonly conversations: ReadonlyArray<ConversationSummary>
  readonly models: ReadonlyArray<ModelSummary>
  readonly notices: ReadonlyArray<Notice>
  readonly tasks?: TaskGraph
}

export interface DurableViewSource {
  current(): DurableView
  subscribe(listener: () => void): () => void
}

export interface DurableController {
  submit(text: string, whenBusy: "steer" | "followUp"): Promise<void>
  compact(instructions: string | undefined): Promise<void>
  abort(): Promise<void>
  cycleThinking(): Promise<void>
  setModel(model: ModelRef): Promise<void>
  toggleTasks(): Promise<void>
  switchConversation(id: ConversationId): Promise<void>
}

export function agentOf(view: ConversationView): AgentState {
  return (view.docs["pi.agent"] ?? {}) as AgentState
}
