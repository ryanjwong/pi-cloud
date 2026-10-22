import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { sqliteStoresOn } from "./index.ts"

export const sqliteStores = (options: { readonly file: string; readonly credentialKey?: string | undefined }) =>
  sqliteStoresOn(async () => {
    mkdirSync(dirname(options.file), { recursive: true })
    return openNodeSqliteDatabase(options.file, { busyTimeoutMs: 5_000 })
  }, options)
