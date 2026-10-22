import { secretsEqual, WakeRequest } from "@pi-cloud/protocol"
import { Effect, Exit, Fiber, Schema, Scope } from "effect"
import { type ControlPlaneClient, makeClient } from "./ControlPlaneClient.ts"
import { hostSession, type SessionRunnerOptions, type StopReason } from "./SessionRunner.ts"

export interface RunnerHostOptions extends SessionRunnerOptions {
  readonly secret?: string
  readonly controlPlaneUrl?: string
  readonly fetch?: typeof globalThis.fetch
  readonly onStop?: (sessionId: string, reason: StopReason) => void
}

const decodeWake = Schema.decodeUnknownPromise(WakeRequest)

export class RunnerHost {
  private readonly scope = Effect.runSync(Scope.make())
  private readonly clients = new Map<string, Promise<ControlPlaneClient>>()
  private readonly sessions = new Map<string, Fiber.Fiber<StopReason>>()
  private readonly deferred = new Map<string, WakeRequest>()

  private readonly options: RunnerHostOptions

  constructor(options: RunnerHostOptions) {
    this.options = options
  }

  async wake(request: WakeRequest): Promise<void> {
    const url = this.options.controlPlaneUrl ?? request.controlPlaneUrl
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
    const fiber = Effect.runFork(hostSession(client, request.sessionId, this.options))
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

  readonly handler = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
    if (this.options.secret === undefined || this.options.controlPlaneUrl === undefined) {
      return new Response("This runner host needs a secret and a pinned control plane URL to accept wake requests", { status: 503 })
    }
    if (!secretsEqual(request.headers.get("authorization") ?? "", `Bearer ${this.options.secret}`)) {
      return new Response("Unauthorized", { status: 401 })
    }
    let wake: WakeRequest
    try {
      wake = await decodeWake(await request.json())
    } catch {
      return new Response("Invalid wake request", { status: 400 })
    }
    await this.wake(wake)
    return new Response(null, { status: 202 })
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
