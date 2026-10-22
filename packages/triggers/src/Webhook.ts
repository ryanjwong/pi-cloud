import { Effect } from "effect"
import { hmacSha256Hex, safeEqual } from "./Signature.ts"
import { defineTrigger, type Trigger, type TriggerEvent, TriggerRejected, type TriggerRequest } from "./Trigger.ts"

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

export const webhookTrigger = (options: {
  readonly name: string
  readonly secret: string
  readonly toEvents: (payload: unknown, request: TriggerRequest) => ReadonlyArray<TriggerEvent>
}): Trigger => {
  if (options.secret === "") throw new Error(`The ${options.name} webhook needs a secret`)
  return defineTrigger({
    name: options.name,
    handle: (request) =>
      Effect.gen(function*() {
        yield* verifyHmac(request, "x-pi-cloud-signature", options.secret)
        return options.toEvents(yield* parseJson(request), request)
      })
  })
}
