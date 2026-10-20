import { Schema } from "effect"

/**
 * Model provider credentials stored by the control plane: API keys, and subscription logins (ChatGPT/Codex,
 * Claude Pro/Max, GitHub Copilot, ...) whose OAuth tokens runners use and refresh. The shape is pi-ai's
 * `Credential`, the same as Pi's `~/.pi/agent/auth.json` entries.
 */
export const StoredCredential = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("api_key"),
    key: Schema.optional(Schema.String),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String))
  }),
  Schema.StructWithRest(
    Schema.Struct({
      type: Schema.Literal("oauth"),
      refresh: Schema.String,
      access: Schema.String,
      /** Expiry of `access`, in epoch milliseconds. */
      expires: Schema.Number
    }),
    [Schema.Record(Schema.String, Schema.Json)]
  )
])
export type StoredCredential = typeof StoredCredential.Type

/** What the API shows about a stored credential: never the secret itself. */
export const CredentialInfo = Schema.Struct({
  providerId: Schema.String,
  type: Schema.Literals(["api_key", "oauth"]),
  /** For OAuth: when the current access token expires; runners refresh it before that. */
  expires: Schema.optional(Schema.Number),
  updatedAt: Schema.Number
})
export type CredentialInfo = typeof CredentialInfo.Type
