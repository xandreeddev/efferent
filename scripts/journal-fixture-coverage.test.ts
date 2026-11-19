import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { Journal } from "@xandreed/core"
import { missingRecords, REQUIRED, SUMMARY_BUDGET, SUMMARY_PRESSURE, summaryPressure } from "./journal-fixture-coverage.js"

const recorded = await Effect.runPromise(Effect.tryPromise(() => readFile(join(import.meta.dir, "../packages/sdk/fixtures/journal-unreleased.json"), "utf8")).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ sessions: Schema.Array(Journal) })))),
))

test("the development recording holds every kind of record a fixture must hold, its summary under a wide margin", () => {
  expect(missingRecords(recorded.sessions)).toEqual([])
  expect(summaryPressure(recorded.sessions, SUMMARY_BUDGET)).toBeGreaterThanOrEqual(SUMMARY_PRESSURE)
})

test("a recording without one kind of record is named for it, each kind on its own", () => {
  for (const kind of REQUIRED) {
    const without = recorded.sessions.map((journal) => ({ ...journal, events: journal.events.filter((event) => !kind.is(event)) }))
    expect(missingRecords(without)).toEqual([kind.name])
  }
})

test("an approval that is not for good does not stand for one", () => {
  const once = recorded.sessions.map((journal) => ({
    ...journal,
    events: journal.events.map((event) => event.name === "plugin.approval.decided" ? { ...event, data: { ...(event.data as object), decision: { _tag: "Approved" } } } : event),
  }))
  expect(missingRecords(once)).toEqual(["an approval for good (plugin.approval.decided, ApprovedAlways)"])
})

test("the pressure is the conversation's messages over the budget, and falls as the budget grows", () => {
  const pressure = summaryPressure(recorded.sessions, SUMMARY_BUDGET)
  expect(summaryPressure(recorded.sessions, 2 * SUMMARY_BUDGET)).toBeCloseTo(pressure / 2, 6)
  expect(summaryPressure([], 150)).toBe(0)
})
