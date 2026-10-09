const encoder = new TextEncoder()

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")

/** HMAC-SHA256 of `message`, hex-encoded. Web Crypto, so it runs on Node, Bun, Deno and Workers alike. */
export const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign"
  ])
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)))
}

/** Compare without leaking how much of the strings matched. */
export const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}
