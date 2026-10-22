import { RUNNER_WAKE_PATH, WakeRequest, webSocketProtocols } from "@pi-cloud/protocol"
import { Effect, Exit, Fiber, Schema, Scope } from "effect"
import { type ControlPlaneClient, makeClient } from "./ControlPlaneClient.ts"
import { hostSession, type SessionRunnerOptions, type StopReason } from "./SessionRunner.ts"

export interface RunnerHostOptions extends SessionRunnerOptions {
  readonly secret?: string
  readonly controlPlaneUrl?: string
  readonly fetch?: typeof globalThis.fetch
  readonly onStop?: (sessionId: string, reason: StopReason) => void
}

const decodeWake = Schema.decodeUnknownPromise(Schema.fromJsonString(WakeRequest))

export class RunnerHost {
  private readonly scope = Effect.runSync(Scope.make())
  private readonly clients = new Map<string, Promise<ControlPlaneClient>>()
  private readonly sessions = new Map<string, Fiber.Fiber<StopReason>>()
  private readonly deferred = new Map<string, WakeRequest>()
  private readonly grants = new Map<string, string>()
  private socket: WebSocket | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private closed = false

  private readonly options: RunnerHostOptions

  constructor(options: RunnerHostOptions) {
    this.options = options
  }

  async wake(request: WakeRequest): Promise<void> {
    const url = this.options.controlPlaneUrl ?? request.controlPlaneUrl
    this.grants.set(request.sessionId, request.grant)
    if (this.sessions.has(request.sessionId)) {
      this.deferred.set(request.sessionId, request)
      return
    }
    const client = await this.client(url)
    if (this.sessions.has(request.sessionId)) {
      this.deferred.set(request.sessionId, request)
      return
    }
    this.deferred.delete(request.sessionId)
    const fiber = Effect.runFork(hostSession(client, request.sessionId, () => this.grants.get(request.sessionId) ?? "", this.options))
    this.sessions.set(request.sessionId, fiber)
    fiber.addObserver((exit) => {
      if (this.sessions.get(request.sessionId) === fiber) this.sessions.delete(request.sessionId)
      this.options.onStop?.(request.sessionId, Exit.isSuccess(exit) ? exit.value : "failed")
      const again = this.deferred.get(request.sessionId)
      if (again !== undefined && !this.sessions.has(request.sessionId)) {
        this.deferred.delete(request.sessionId)
        void this.wake(again).catch(() => {})
      }
    })
  }

  connect(): void {
    if (this.closed) return
    const { controlPlaneUrl, secret } = this.options
    if (controlPlaneUrl === undefined || secret === undefined) throw new Error("Pulling wake requests needs a secret and a control plane URL")
    const url = new URL(RUNNER_WAKE_PATH, controlPlaneUrl)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    const socket = new WebSocket(url, webSocketProtocols(secret))
    this.socket = socket
    socket.addEventListener("message", (event) => void decodeWake(String(event.data)).then((wake) => this.wake(wake)).catch(() => {}))
    const reconnect = () => {
      if (this.socket !== socket || this.closed) return
      this.socket = undefined
      this.retry = setTimeout(() => this.connect(), 1_000)
    }
    socket.addEventListener("error", reconnect)
    socket.addEventListener("close", reconnect)
  }

  hosted(): ReadonlyArray<string> {
    return [...this.sessions.keys()]
  }

  async settled(sessionId: string): Promise<StopReason | undefined> {
    const fiber = this.sessions.get(sessionId)
    return fiber === undefined ? undefined : Effect.runPromise(Fiber.join(fiber))
  }

  async kill(): Promise<void> {
    this.deferred.clear()
    const fibers = [...this.sessions.values()]
    this.sessions.clear()
    await Effect.runPromise(Fiber.interruptAll(fibers))
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.retry)
    this.socket?.close()
    await this.kill()
    await Effect.runPromise(Scope.close(this.scope, Exit.void))
  }

  private client(url: string): Promise<ControlPlaneClient> {
    let client = this.clients.get(url)
    if (client === undefined) {
      client = Effect.runPromise(Scope.provide(this.scope)(makeClient({ url, secret: this.options.secret, fetch: this.options.fetch })))
      this.clients.set(url, client)
    }
    return client
  }
}
