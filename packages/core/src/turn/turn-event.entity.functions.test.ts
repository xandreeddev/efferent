import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { failureCode } from "../conformance.functions.js"
import type { TurnDraft } from "../ports/sessions.port.js"
import { draftOfTurnEvent } from "../session/session-event.entity.functions.js"
import { defineHostEvent } from "./turn-event.entity.functions.js"
import type { TurnEvent } from "./turn-event.entity.js"

const Note = defineHostEvent("note.saved", Schema.Struct({
  id: Schema.String,
  at: Schema.DateFromMillis,
  tags: Schema.Array(Schema.String),
  draft: Schema.optional(Schema.String),
}))
const note = { id: "n1", at: new Date(5), tags: ["a", "b"], draft: undefined }

/** A stored record as a host reads it back, as the host event `select` takes. */
const hostEventOf = (record: TurnDraft): TurnEvent => ({ _tag: "host", name: record.kind, data: record.data })

describe("a host event's draft", () => {
  test("stores what the turn's writer stores for the same event published on the bus: kind and data, byte for byte", async () => {
    const { drafted, published } = await Effect.runPromise(Effect.gen(function* () {
      const drafted = yield* Note.draft(note)
      const event = yield* Note.make(note)
      const published = yield* draftOfTurnEvent(3, event)
      return { drafted, published }
    }))
    expect(Option.isSome(published)).toBe(true)
    const stored = Option.getOrThrow(published)
    expect(drafted).toStrictEqual({ kind: "note.saved", data: { id: "n1", at: 5, tags: ["a", "b"] } })
    expect(drafted.kind).toBe(stored.kind)
    expect(JSON.stringify(drafted.data)).toBe(JSON.stringify(stored.data))
  })

  test("reads back through select, decoded by the event's schema", async () => {
    const drafted = await Effect.runPromise(Note.draft(note))
    expect(Note.select(hostEventOf(drafted))).toStrictEqual(Option.some({ id: "n1", at: new Date(5), tags: ["a", "b"] }))
    expect(defineHostEvent("note.other", Schema.Struct({ id: Schema.String })).select(hostEventOf(drafted))).toStrictEqual(Option.none())
  })

  test("a payload JSON cannot hold fails with events.encode, as make does", async () => {
    const Tally = defineHostEvent("tally.saved", Schema.Struct({ n: Schema.BigInt }))
    const drafted = await Effect.runPromise(Effect.result(Tally.draft({ n: 1n })))
    const made = await Effect.runPromise(Effect.result(Tally.make({ n: 1n })))
    expect(drafted._tag === "Failure" ? failureCode(drafted.failure) : "drafted").toBe("events.encode")
    expect(made._tag === "Failure" ? failureCode(made.failure) : "made").toBe("events.encode")
  })
})
