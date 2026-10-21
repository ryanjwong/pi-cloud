import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { sqliteStoresOn } from "./index.ts"

/**
 * Every control-plane store in one SQLite file, for Node. The file is the whole state of the control plane: copy
 * it, or stream it to object storage with Litestream.
 */
export const sqliteStores = (options: { readonly file: string; readonly credentialKey?: string | undefined }) =>
  sqliteStoresOn(async () => {
    mkdirSync(dirname(options.file), { recursive: true })
    return openNodeSqliteDatabase(options.file, { busyTimeoutMs: 5_000 })
  }, options)
