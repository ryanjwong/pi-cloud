/** The API key as a bearer header, for HTTP and WebSocket requests alike. */
export const authorization = (apiKey: string | undefined): Record<string, string> =>
  apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }
