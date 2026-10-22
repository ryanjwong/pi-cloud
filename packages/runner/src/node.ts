import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node"
import { DatabaseSync } from "node:sqlite"
import type { ReplicaDatabase } from "./ReplicatedStorage.ts"

export const memoryReplica: ReplicaDatabase = async () => new NodeSqliteDatabase(new DatabaseSync(":memory:"))
