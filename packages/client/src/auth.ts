export const authorization = (apiKey: string | undefined): Record<string, string> =>
  apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }
