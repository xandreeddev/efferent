import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { ProcessCommand, ProcessEvent, ProcessFullEvent, ProcessProjection } from "./process-protocol.entity.js"
import { decodeProcessCommand, encodeProcessEvent } from "./process-protocol.entity.functions.js"

const strict = { onExcessProperty: "error" } as const
const fixture = new URL("../fixtures/protocol-1.ndjson", import.meta.url)

test("the immutable protocol 1 fixture retains its exact bytes and every command/event variant", async () => {
  const text = await readFile(fixture, "utf8")
  expect(createHash("sha256").update(text).digest("hex")).toBe("630e6ea0edfa2f2fd630464a316bc649de770e829234aa270e15eca8ff0abf18")
  expect(text.endsWith("\n")).toBe(true)
  const lines = text.slice(0, -1).split("\n")
  expect(lines).toHaveLength(45)
  const commands = await Effect.runPromise(Effect.forEach(lines.slice(0, 8), decodeProcessCommand, { concurrency: 1 }))
  expect(commands.map((command) => command._tag)).toEqual([...ProcessCommand.discriminants])
  const events = await Effect.runPromise(Effect.forEach(lines.slice(8), (line) => Schema.decodeUnknownEffect(Schema.fromJsonString(ProcessEvent))(line, strict), { concurrency: 1 }))
  expect([...new Set(events.map((event) => event._tag))].sort()).toEqual([...ProcessEvent.discriminants].sort())
  await Effect.runPromise(Effect.forEach(events, (event) => Effect.gen(function* () {
    const encoded = yield* encodeProcessEvent(event)
    expect(yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProcessEvent))(encoded, strict)).toEqual(event)
  }), { concurrency: 1 }))
  const progress = events.flatMap((event) => event._tag === "turn.event" ? [event.progress] : [])
  expect(progress.filter((item) => item.mode === "projection").map((item) => item.event._tag)).toEqual([...ProcessProjection.discriminants])
  expect(progress.filter((item) => item.mode === "full").map((item) => item.event._tag)).toEqual(ProcessFullEvent.members.map((member) => member.fields._tag.schema.literal))
})
