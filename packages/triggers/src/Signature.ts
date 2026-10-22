const encoder = new TextEncoder()

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")

export const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign"
  ])
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)))
}

export const sha256Hex = async (message: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(message)))

export const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}
