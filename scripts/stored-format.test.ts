import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { STORED_FORMAT } from "@xandreed/core"
import { canonicalShape, fingerprintOf, formatProblems, nextRecord, storedShapes, StoredFormatRecord } from "./stored-format.js"

const Before = Schema.Struct({ turn: Schema.Int, text: Schema.String })
const Reworded = Schema.Struct({ turn: Schema.Int.annotate({ description: "the turn it belongs to" }), text: Schema.String }).annotate({ description: "a note" })
const Added = Schema.Struct({ turn: Schema.Int, text: Schema.String, meta: Schema.optionalKey(Schema.String) })
const Tightened = Schema.Struct({ turn: Schema.Int.check(Schema.isGreaterThan(0)), text: Schema.String })

const shapesWith = (note: Schema.Top) => fingerprintOf([{ name: "journal note.recorded", schema: note }, { name: "SessionHeader", schema: Before }])

describe("canonicalShape", () => {
  test("a description or a title changes nothing a reader can tell", () => {
    expect(canonicalShape(Reworded)).toBe(canonicalShape(Before))
  })

  test("a new optional key and a tightened check each change the shape", () => {
    expect(canonicalShape(Added)).not.toBe(canonicalShape(Before))
    expect(canonicalShape(Tightened)).not.toBe(canonicalShape(Before))
  })
})

describe("formatProblems", () => {
  const original = shapesWith(Before)
  const recorded = Option.some(nextRecord(Option.none(), original, 1))

  test("none before any record at format 1, and none when the shapes are the ones recorded", () => {
    expect(formatProblems(Option.none(), original, 1)).toEqual([])
    expect(formatProblems(recorded, original, 1)).toEqual([])
    expect(formatProblems(recorded, shapesWith(Reworded), 1)).toEqual([])
  })

  test("a changed shape without a bump is a problem that names it and the format to raise to", () => {
    expect(formatProblems(recorded, shapesWith(Added), 1)).toEqual([
      "A stored shape changed (journal note.recorded) without a bump: raise STORED_FORMAT in packages/core/src/session/stored-format.entity.ts to 2 and name the change in CHANGELOG.md",
    ])
  })

  test("a bump with the change is clean, appends its row, and the next run at that format is clean", () => {
    const added = shapesWith(Added)
    expect(formatProblems(recorded, added, 2)).toEqual([])
    const bumped = nextRecord(recorded, added, 2)
    expect(bumped.history.map((row) => row.format)).toEqual([1, 2])
    expect(bumped.history[0]?.fingerprint).toBe(original.fingerprint)
    expect(formatProblems(Option.some(bumped), added, 2)).toEqual([])
    expect(formatProblems(Option.some(bumped), shapesWith(Tightened), 2)).toEqual([
      "A stored shape changed (journal note.recorded) without a bump: raise STORED_FORMAT in packages/core/src/session/stored-format.entity.ts to 3 and name the change in CHANGELOG.md",
    ])
  })

  test("a bump without a change, a format skipped or lowered, and a history with a gap are problems", () => {
    expect(formatProblems(recorded, original, 2)).toEqual(["STORED_FORMAT was raised to 2, but no stored shape changed since format 1: a format names a change"])
    expect(formatProblems(recorded, shapesWith(Added), 3)).toEqual(["STORED_FORMAT is 3, but the last recorded format is 1: bump it by one"])
    const two = Option.some(nextRecord(recorded, shapesWith(Added), 2))
    expect(formatProblems(two, shapesWith(Added), 1)).toEqual(["STORED_FORMAT is 1, below the last recorded format 2: a format is never lowered"])
    const gapped = Option.map(two, (record) => ({ ...record, history: [record.history[1] ?? { format: 2, fingerprint: "" }] }))
    expect(formatProblems(gapped, shapesWith(Added), 2)).toEqual(["The stored format history is not 1, 2, 3…: row 1 is format 2"])
    expect(formatProblems(Option.none(), original, 2)).toEqual(["docs/stored-format.json is missing: STORED_FORMAT is 2, and a first record starts at 1"])
  })
})

describe("the repository's stored format", () => {
  test("every journal kind has a schema, and docs/stored-format.json records the shapes as the code has them at STORED_FORMAT", async () => {
    const { shapes, problems } = storedShapes()
    expect(problems).toEqual([])
    const record = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(StoredFormatRecord))(await readFile(join(import.meta.dir, "../docs/stored-format.json"), "utf8")))
    const current = fingerprintOf(shapes)
    expect(formatProblems(Option.some(record), current, STORED_FORMAT)).toEqual([])
    expect(record.format).toBe(STORED_FORMAT)
    expect(record.fingerprint).toBe(current.fingerprint)
  })
})
