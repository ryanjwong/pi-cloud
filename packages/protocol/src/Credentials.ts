import { Schema } from "effect"

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
      expires: Schema.Number
    }),
    [Schema.Record(Schema.String, Schema.Json)]
  )
])
export type StoredCredential = typeof StoredCredential.Type

export const CredentialInfo = Schema.Struct({
  providerId: Schema.String,
  type: Schema.Literals(["api_key", "oauth"]),
  expires: Schema.optional(Schema.Number),
  updatedAt: Schema.Number
})
export type CredentialInfo = typeof CredentialInfo.Type
