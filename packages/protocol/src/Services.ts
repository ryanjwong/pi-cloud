/**
 * The service API: Chord services, served with Pi's own server protocol (`@earendil-works/pi-protocol`) over
 * the WebSocket at `/v1/pi`. Connect with `@earendil-works/pi-client` (see `connectServices` in
 * `@pi-cloud/client`). This is what presentations are built on: a TUI, a web UI, a dashboard.
 *
 * Server services (target `{ serverId }`): the session directory and management, Pi's contracts, plus
 * `pi-cloud.sessions` with pi-cloud's session details. Session services (target: the attachment the server
 * publishes after `SessionManagement.attach`), served by the session's runner in the cloud:
 *
 * - Pi's `pi.transcript`, `pi.agent-controller` and `pi.models`, for the root conversation, exactly as Pi's own
 *   server serves them;
 * - `pi-cloud.conversation`, keyed: one instance per conversation (the root and every subagent's), each with its
 *   view and controls;
 * - `pi-cloud.tasks`: Pi Durable's live task graph, and aborting a task;
 * - `pi-cloud.notices`: what went wrong without an error to return (a prompt that ended unanswered, a
 *   compaction's outcome, runner warnings).
 *
 * Plugins on the runner can provide more session services; the catalogue lists them.
 *
 * The `pi.*` contracts are Pi's (github.com/earendil-works/pi, v1.1.0,
 * packages/coding-agent/src/experimental/services; MIT License, Copyright (c) 2025 Mario Zechner).
 */
import { type Context, defineService, type JsonValue, type ReplicatedState } from "@earendil-works/chord"
import type { ModelThinkingLevel } from "@earendil-works/pi-ai"
import type { ConversationView, TaskGraph } from "@earendil-works/pi-durable"
import type { ModelRef } from "./Domain.ts"

// ---------------------------------------------------------------------------------------------------------------
// Pi's session services

/** The root conversation's durable view: active entries and its live, inbox, agent, and usage documents. */
export interface Transcript {
  readonly state: ReplicatedState<ConversationView>
}
export const Transcript = defineService<Transcript>("pi.transcript")

export interface AgentPromptImage {
  type: "image"
  data: string
  mimeType: string
}

export interface AgentPromptRequest {
  message: string
  images: Array<AgentPromptImage> | null
}

export interface AgentOperationError {
  code: string
  message: string
}

/** `operationId` identifies the durable submission of a prompt, or the task of a compaction. */
export type AgentOperationResponse =
  | { accepted: true; operationId: string; error: null }
  | { accepted: false; operationId: null; error: AgentOperationError }

/** `entryId` identifies the durable submission; `cancelQueued()` withdraws it while it is still queued. */
export type AgentQueueResponse =
  | { accepted: true; entryId: string; error: null }
  | { accepted: false; entryId: null; error: AgentOperationError }

/** The settled outcome of a prompt: the answer's text, or why it got none. */
export type AgentPromptResult =
  | { status: "done"; text: string; reason: null }
  | { status: "unanswered"; text: null; reason: string }

export interface AgentCompactionRequest {
  customInstructions: string | null
}

/** Commands for a conversation: prompting, steering, queueing, aborting, compacting. */
export interface AgentController {
  /** Start a run; rejected with `busy` while one is active. */
  prompt(request: AgentPromptRequest, context: Context): Promise<AgentOperationResponse>
  /** Steer the active run, or start one when idle. */
  steer(request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>
  /** Queue input for after the active run, or start one when idle. */
  followUp(request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>
  cancelQueued(entryId: string, context: Context): Promise<{ outcome: "cancelled" | "already_consumed" | "not_found" }>
  /** Withdraw queued input and abort the active run and compaction. */
  abort(context: Context): Promise<void>
  compact(request: AgentCompactionRequest, context: Context): Promise<AgentOperationResponse>
  /** Wait until the prompt with this `operationId` is answered or settles unanswered. */
  waitForPrompt(operationId: string, context: Context): Promise<AgentPromptResult>
}
export const AgentController = defineService<AgentController>("pi.agent-controller")

export interface ModelSummary {
  provider: string
  modelId: string
  name: string
  reasoning: boolean
  /** pi-cloud adds the context window, for context-usage displays. */
  contextWindow?: number
}

export interface ModelsState {
  catalog: { revision: number; availableModels: Array<ModelSummary> }
  configuration: { model: ModelRef | null; thinkingLevel: ModelThinkingLevel }
  refresh: { status: "idle" | "refreshing" | "done" } | { status: "warning"; errors: Record<string, string> }
}

/** The models the runner can use, and the conversation's model and thinking level. */
export interface Models {
  readonly state: ReplicatedState<ModelsState>
  cycleThinking(context: Context): Promise<void>
  getThinkingLevels(context: Context): Promise<Array<ModelThinkingLevel>>
  refresh(context: Context): Promise<void>
  select(model: ModelRef, context: Context): Promise<void>
  selectThinking(level: ModelThinkingLevel, context: Context): Promise<void>
}
export const Models = defineService<Models>("pi.models")

// ---------------------------------------------------------------------------------------------------------------
// Pi's server services

export interface SessionAddress {
  serverId: string
  sessionId: string
}

export interface SessionSummary extends SessionAddress {
  createdAt: number
}

export interface SessionCreateOptions {
  id?: string
}

export interface SessionDirectoryState {
  revision: number
  sessions: Array<SessionSummary>
}

export interface SessionDirectory {
  readonly state: ReplicatedState<SessionDirectoryState>
}
export const SessionDirectory = defineService<SessionDirectory>("pi.session-directory")

/** Create, remove, and attach to sessions. Attaching makes the connection's session services that session's. */
export interface SessionManagement {
  create(options: SessionCreateOptions, context: Context): Promise<SessionSummary>
  remove(sessionId: string, context: Context): Promise<void>
  attach(sessionId: string, context: Context): Promise<void>
  detach(context: Context): Promise<void>
}
export const SessionManagement = defineService<SessionManagement>("pi.session-management")

// ---------------------------------------------------------------------------------------------------------------
// pi-cloud's services

/** A session as pi-cloud knows it: its spec (model, sandbox, metadata) and where it runs. */
export interface CloudSession {
  id: string
  title: string | null
  createdAt: number
  /** The `SessionSpec`, as JSON. */
  spec: JsonValue
  runner: { state: "idle" | "starting" | "running"; runnerId: string | null }
}

export interface CloudSessionsState {
  revision: number
  sessions: Array<CloudSession>
}

/** pi-cloud's sessions with their details, live; and creating one with a spec. */
export interface CloudSessions {
  readonly state: ReplicatedState<CloudSessionsState>
  create(input: { title: string | null; spec: JsonValue }, context: Context): Promise<CloudSession>
}
export const CloudSessions = defineService<CloudSessions>("pi-cloud.sessions")

export interface ConversationSummary {
  id: number
  /** `main` for the root conversation, `subagent N` for a subagent's. */
  label: string
  /** The conversation's first user message; for a subagent, its task. */
  title: string | null
}

/**
 * One conversation of the session, keyed by its id: the root (`"1"`) and every subagent's. Pi's `Transcript`,
 * `AgentController` and `Models` cover the root only; this reaches every conversation.
 */
export interface Conversation extends AgentController {
  readonly summary: ReplicatedState<ConversationSummary>
  readonly state: ReplicatedState<ConversationView>
  /** Cycle the thinking level through those the conversation's model supports. */
  cycleThinking(context: Context): Promise<void>
  /** Switch model, keeping the thinking level, clamped to what the new model supports. */
  selectModel(model: ModelRef, context: Context): Promise<void>
}
export const Conversations = defineService<Conversation>("pi-cloud.conversation")

/** Pi Durable's live task graph: every live task, what it waits on, and the conversations it owns. */
export interface Tasks {
  readonly state: ReplicatedState<TaskGraph>
  /** Abort one task and what it owns. */
  abort(taskId: number, context: Context): Promise<void>
}
export const Tasks = defineService<Tasks>("pi-cloud.tasks")

export interface Notice {
  id: number
  level: "info" | "warning" | "error"
  message: string
}

export interface NoticesState {
  notices: Array<Notice>
}

export interface Notices {
  readonly state: ReplicatedState<NoticesState>
}
export const Notices = defineService<Notices>("pi-cloud.notices")

/** Every service a session serves, for bindings. */
export const SESSION_SERVICES = [Transcript, AgentController, Models, Conversations, Tasks, Notices] as const
/** Every service the server serves, for bindings. */
export const SERVER_SERVICES = [SessionDirectory, SessionManagement, CloudSessions] as const
