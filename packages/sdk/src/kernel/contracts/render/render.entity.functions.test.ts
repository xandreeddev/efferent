import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { TableView } from "./render.entity.js"
import { EventName, Seq, TurnNumber } from "@xandreed/core/kernel"
import type { StoredEvent } from "@xandreed/core/kernel"
import { viewsOf } from "./render.entity.functions.js"

const record = (seq: number, name: string, data: StoredEvent["data"]): StoredEvent =>
  ({ seq: Seq.make(seq), at: 0, turn: TurnNumber.make(1), name: EventName.make(name), tags: [], data, skippable: true })

describe("viewsOf", () => {
  test("one view per id, the latest record's, in the order the ids first appeared; other records and unknown shapes passed over", () => {
    const journal = [
      record(1, "plugin.render.view", { id: "a", view: { _tag: "Text", text: "first" } }),
      record(2, "plugin.render.view", { id: "b", view: { _tag: "Card", title: "B", body: "b" } }),
      record(3, "plugin.other.view", { id: "a", view: { _tag: "Text", text: "not a view of render's" } }),
      record(4, "plugin.render.view", { id: "c", view: { _tag: "Chart", points: [1, 2] } }),
      record(5, "plugin.render.view", { id: "a", view: { _tag: "List", items: ["x", "y"] } }),
    ]
    expect(viewsOf(journal).map((one) => ({ ...one, id: String(one.id), firstSeq: Number(one.firstSeq), turn: Number(one.turn), seq: Number(one.seq) }))).toEqual([
      { id: "a", view: { _tag: "List", items: ["x", "y"] }, firstSeq: 1, turn: 1, seq: 5 },
      { id: "b", view: { _tag: "Card", title: "B", body: "b" }, firstSeq: 2, turn: 1, seq: 2 },
    ])
  })

  test("a table whose rows do not each have one cell per column is no view", () => {
    const decode = Schema.decodeUnknownOption(TableView)
    expect(Option.isSome(decode({ _tag: "Table", columns: ["n", "n²"], rows: [["1", "1"]] }))).toBe(true)
    expect(Option.isNone(decode({ _tag: "Table", columns: ["n", "n²"], rows: [["1"]] }))).toBe(true)
  })
})
