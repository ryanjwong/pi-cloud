import type { SessionSpec } from "@pi-cloud/protocol"
import { defineSource, DeliveryFailed, type InboundMessage, type Source } from "@pi-cloud/sources"
import { hmacSha256Hex, parseJson, safeEqual, TriggerRejected, type TriggerRequest } from "@pi-cloud/triggers"
import { Effect } from "effect"

/** Where a reply goes: a channel and the thread to answer in. */
export interface SlackTarget {
  readonly channel: string
  readonly thread_ts: string
}

/** The fields of Slack Events API callbacks this source reads. */
interface SlackEnvelope {
  readonly type: string
  readonly challenge?: string
  readonly team_id?: string
  readonly event_id?: string
  readonly event?: {
    readonly type: string
    readonly channel: string
    readonly channel_type?: string
    readonly user?: string
    readonly bot_id?: string
    readonly subtype?: string
    readonly text?: string
    readonly ts: string
    readonly thread_ts?: string
  }
}

export interface SlackSourceOptions {
  /** The app's signing secret; requests without a valid `X-Slack-Signature` are refused. */
  readonly signingSecret: string
  /** Bot token used to post replies (`chat.postMessage`). */
  readonly botToken: string
  /** Mounted at `/v1/sources/{name}`. Defaults to `slack`. */
  readonly name?: string
  /** Spec for new sessions. */
  readonly spec?: SessionSpec
  /** Slack Web API base URL; override in tests. */
  readonly apiUrl?: string
  /** Oldest accepted request timestamp, in seconds of skew. Defaults to 5 minutes. */
  readonly toleranceSeconds?: number
}

/** Verify Slack's `v0` request signature over `v0:{timestamp}:{body}`. */
export const verifySlackRequest = (request: TriggerRequest, signingSecret: string, toleranceSeconds = 300) =>
  Effect.gen(function*() {
    const timestamp = request.headers["x-slack-request-timestamp"] ?? ""
    const signature = request.headers["x-slack-signature"] ?? ""
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) {
      return yield* new TriggerRejected({ status: 401, message: "Stale or missing timestamp" })
    }
    const expected = `v0=${yield* Effect.promise(() => hmacSha256Hex(signingSecret, `v0:${timestamp}:${request.body}`))}`
    if (!safeEqual(signature, expected)) return yield* new TriggerRejected({ status: 401, message: "Bad signature" })
  })

/** Mentions of the bot (`<@U123>`) are addressing, not content. */
const stripMentions = (text: string) => text.replace(/<@[A-Z0-9]+>/g, "").trim()

/**
 * Slack as a source. Every thread is one session: mentioning the app (or messaging it directly) starts or
 * continues the thread's session, later replies in a thread the agent is part of reach it without a mention, and
 * the agent's answers are posted back into the thread.
 */
export const slackSource = (options: SlackSourceOptions): Source => {
  const apiUrl = options.apiUrl ?? "https://slack.com/api"
  return defineSource({
    name: options.name ?? "slack",
    receive: (request) =>
      Effect.gen(function*() {
        yield* verifySlackRequest(request, options.signingSecret, options.toleranceSeconds)
        const envelope = (yield* parseJson(request)) as SlackEnvelope
        if (envelope.type === "url_verification") {
          return { messages: [], response: { json: { challenge: envelope.challenge } } }
        }
        const event = envelope.event
        if (envelope.type !== "event_callback" || event === undefined) return { messages: [] }
        // Ignore the bot's own posts, edits, joins and other non-message subtypes.
        if (event.bot_id !== undefined || event.subtype !== undefined || event.user === undefined) return { messages: [] }

        const thread = event.thread_ts ?? event.ts
        const message: InboundMessage = {
          key: `slack:${envelope.team_id ?? "team"}:${event.channel}:${thread}`,
          content: stripMentions(event.text ?? ""),
          target: { channel: event.channel, thread_ts: thread } satisfies SlackTarget,
          requestId: envelope.event_id,
          title: `Slack thread in ${event.channel}`,
          spec: options.spec
        }
        if (event.type === "app_mention") return { messages: [message] }
        if (event.type === "message" && event.channel_type === "im") return { messages: [message] }
        // A plain message in a thread: only for threads the agent is already part of.
        if (event.type === "message" && event.thread_ts !== undefined) {
          return { messages: [{ ...message, onlyIfBound: true }] }
        }
        return { messages: [] }
      }),
    deliver: (target, reply) =>
      Effect.tryPromise({
        try: async () => {
          const { channel, thread_ts } = target as unknown as SlackTarget
          const response = await fetch(`${apiUrl}/chat.postMessage`, {
            method: "POST",
            headers: {
              "content-type": "application/json; charset=utf-8",
              authorization: `Bearer ${options.botToken}`
            },
            body: JSON.stringify({ channel, thread_ts, text: reply.text })
          })
          const result = (await response.json()) as { ok?: boolean; error?: string }
          if (!response.ok || result.ok !== true) throw new Error(result.error ?? `HTTP ${response.status}`)
        },
        catch: (cause) => new DeliveryFailed({ message: cause instanceof Error ? cause.message : String(cause) })
      })
  })
}
