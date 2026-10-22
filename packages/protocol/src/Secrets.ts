import { Result } from "effect"
import { Base64Url } from "effect/encoding"

export const secretsEqual = (presented: string, expected: string): boolean => {
  let difference = presented.length ^ expected.length
  for (let index = 0; index < expected.length; index++) {
    difference |= (presented.charCodeAt(index) | 0) ^ expected.charCodeAt(index)
  }
  return difference === 0
}

export const WEBSOCKET_PROTOCOL = "pi-cloud.v1"

export const webSocketProtocols = (token: string | undefined): Array<string> =>
  token === undefined ? [WEBSOCKET_PROTOCOL] : [WEBSOCKET_PROTOCOL, `bearer.${Base64Url.encode(token)}`]

export const bearerOf = (headers: Readonly<Record<string, string | undefined>>): string | undefined => {
  const encoded = headers["sec-websocket-protocol"]?.split(",").map((protocol) => protocol.trim()).find((protocol) => protocol.startsWith("bearer."))
  return /^Bearer\s+(\S+)$/i.exec(headers["authorization"] ?? "")?.[1] ??
    (encoded === undefined ? undefined : Result.getOrUndefined(Base64Url.decodeString(encoded.slice(7))))
}
