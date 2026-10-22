import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node"
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs"
import { dirname } from "node:path"
import { sqliteStoresOn } from "./index.ts"

export const sqliteStores = (options: { readonly file: string; readonly credentialKeys: ReadonlyArray<string> }) =>
  sqliteStoresOn(async () => {
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 })
    closeSync(openSync(options.file, "a", 0o600))
    chmodSync(options.file, 0o600)
    return openNodeSqliteDatabase(options.file, { busyTimeoutMs: 5_000 })
  }, options)
