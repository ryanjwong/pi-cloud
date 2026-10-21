import { secretsEqual, WakeRequest } from "@pi-cloud/protocol"
import { Effect, Exit, Fiber, Schema, Scope } from "effect"
import { type ControlPlaneClient, makeClient } from "./ControlPlaneClient.ts"
import { hostSession, type SessionRunnerOptions, type StopReason } from "./SessionRunner.ts"

export interface RunnerHostOptions extends SessionRunnerOptions {
  /** Shared secret for the runner RPC, and for authenticating wake requests. */
  readonly secret?: string
  /**
   * The control plane runners attach to. `handler` requires it (with `secret`): a wake request must never choose
   * where a runner connects. Without it, `wake` uses the URL in the request.
   */
  readonly controlPlaneUrl?: string
  /** How requests reach the control plane: a Durable Object stub's `fetch`, for instance. Default: `fetch`. */
  readonly fetch?: typeof globalThis.fetch
  /** Called when a session stops being hosted here. */
  readonly onStop?: (sessionId: string, reason: StopReason) => void
}

const decodeWake = Schema.decodeUnknownPromise(WakeRequest)

/**
 * Hosts any number of sessions in one process, isolate, or object. A substrate adapter only has to forward wake
 * requests to `wake` (or mount `handler`); everything else happens over outbound HTTP to the control plane.
 */
export class RunnerHost {
  private readonly scope = Effect.runSync(Scope.make())
  private readonly clients = new Map<string, Promise<ControlPlaneClient>>()
  private readonly sessions = new Map<string, Fiber.Fiber<StopReason>>()

  private readonly options: RunnerHostOptions

  constructor(options: RunnerHostOptions) {
    this.options = options
  }

  /** Start hosting the session unless it is already hosted here. Returns once the runner is starting. */
  async wake(request: WakeRequest): Promise<void> {
    const url = this.options.controlPlaneUrl ?? request.controlPlaneUrl
    if (this.sessions.has(request.sessionId)) return
    const client = await this.client(url)
    if (this.sessions.has(request.sessionId)) return
    const fiber = Effect.runFork(hostSession(client, request.sessionId, this.options))
    this.sessions.set(request.sessionId, fiber)
    fiber.addObserver((exit) => {
      if (this.sessions.get(request.sessionId) === fiber) this.sessions.delete(request.sessionId)
      this.options.onStop?.(request.sessionId, Exit.isSuccess(exit) ? exit.value : "failed")
    })
  }

  /** A fetch-style handler for `POST` wake requests with a JSON `WakeRequest` body. */
  readonly handler = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
    // A wake request starts a runner that spends this host's model keys and sandbox secrets on the sessions it is
    // given, so it must come from the control plane: authenticated, and never naming where the runner connects.
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

  /** Sessions hosted right now. */
  hosted(): ReadonlyArray<string> {
    return [...this.sessions.keys()]
  }

  /** Wait until the session is no longer hosted here. */
  async settled(sessionId: string): Promise<StopReason | undefined> {
    const fiber = this.sessions.get(sessionId)
    return fiber === undefined ? undefined : Effect.runPromise(Fiber.join(fiber))
  }

  /** Stop hosting everything without releasing leases, as a crash would. Useful for tests and fast shutdown. */
  async kill(): Promise<void> {
    const fibers = [...this.sessions.values()]
    this.sessions.clear()
    await Effect.runPromise(Fiber.interruptAll(fibers))
  }

  /** Stop hosting everything and close connections. */
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
