import type { JsonValue } from "@earendil-works/chord"
import { diffRevisions } from "@earendil-works/chord/delta"
import { describe, expect, it } from "vitest"
import { ViewReplica } from "../src/View.ts"

const ops = (before: JsonValue, after: JsonValue) => diffRevisions(before, after) as unknown as Array<never>

describe("ViewReplica", () => {
  it("applies snapshots and operations per state", () => {
    const replica = new ViewReplica()
    let changes = 0
    replica.subscribe(() => changes++)
    const first = { entries: [{ id: 1, kind: "pi.user" }], docs: {} }
    const second = { entries: [{ id: 1, kind: "pi.user" }, { id: 2, kind: "pi.assistant" }], docs: { "pi.live": {} } }
    replica.apply({ epoch: 1, seq: 1, conversationId: 1, frame: { _tag: "Snapshot", value: first } })
    replica.apply({ epoch: 1, seq: 2, conversationId: 1, frame: { _tag: "Ops", ops: ops(first, second) } })
    replica.apply({ epoch: 1, seq: 3, frame: { _tag: "Snapshot", value: { conversations: [], models: [], notices: [] } } })
    expect(replica.conversation(1)).toEqual(second)
    expect(replica.session).toEqual({ conversations: [], models: [], notices: [] })
    expect(changes).toBe(3)
  })

  it("ignores operations from another runner until its snapshot arrives", () => {
    const replica = new ViewReplica()
    const value = { n: 1 }
    replica.apply({ epoch: 1, seq: 1, conversationId: 1, frame: { _tag: "Snapshot", value } })
    replica.apply({ epoch: 2, seq: 1, conversationId: 1, frame: { _tag: "Ops", ops: ops(value, { n: 2 }) } })
    expect(replica.conversation(1)).toEqual({ n: 1 })
    replica.apply({ epoch: 2, seq: 2, conversationId: 1, frame: { _tag: "Snapshot", value: { n: 3 } } })
    expect(replica.conversation(1)).toEqual({ n: 3 })
    expect(replica.conversation(2)).toBeUndefined()
  })
})
