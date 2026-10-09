import { Effect } from "effect"
import { hmacSha256Hex, safeEqual } from "./Signature.ts"
import { defineTrigger, type Trigger, type TriggerEvent, TriggerRejected, type TriggerRequest } from "./Trigger.ts"

/** Verify a `sha256=<hex>` HMAC header over the raw body. */
export const verifyHmac = (request: TriggerRequest, header: string, secret: string) =>
  Effect.gen(function*() {
    const signature = request.headers[header.toLowerCase()] ?? ""
    const expected = `sha256=${yield* Effect.promise(() => hmacSha256Hex(secret, request.body))}`
    if (!safeEqual(signature, expected)) return yield* new TriggerRejected({ status: 401, message: "Bad signature" })
  })

export const parseJson = (request: TriggerRequest) =>
  Effect.try({
    try: () => JSON.parse(request.body) as unknown,
    catch: () => new TriggerRejected({ status: 400, message: "Body is not JSON" })
  })

/**
 * A generic JSON webhook. With a `secret`, senders sign the raw body: `x-pi-cloud-signature: sha256=<hmac hex>`.
 * `toEvents` maps the payload to events; return none to ignore it.
 */
export const webhookTrigger = (options: {
  readonly name: string
  readonly secret?: string
  readonly toEvents: (payload: unknown, request: TriggerRequest) => ReadonlyArray<TriggerEvent>
}): Trigger =>
  defineTrigger({
    name: options.name,
    handle: (request) =>
      Effect.gen(function*() {
        if (options.secret !== undefined) yield* verifyHmac(request, "x-pi-cloud-signature", options.secret)
        return options.toEvents(yield* parseJson(request), request)
      })
  })
