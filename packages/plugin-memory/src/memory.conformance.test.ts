import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { longTermMemoryConformance } from "@xandreed/core/conformance"
import { fixtureExtraction, fixtureScope, makeMemoryFixture } from "./memory.testing.js"

const open = makeMemoryFixture([JSON.stringify(fixtureExtraction("I prefer tea."))])
const checks = longTermMemoryConformance({ open: Effect.map(open, ({ memory }) => ({ memory, scope: fixtureScope })) })

describe("native memory facade conformance", () => {
  checks.forEach((check) => test(check.name, () => Effect.runPromise(check.run)))
  test("the source-filter check rejects recall that ignores the filter", async () => {
    const unfiltered = longTermMemoryConformance({ open: Effect.map(open, ({ memory }) => ({ memory: { ...memory, recall: ({ sources: _ignored, ...input }) => memory.recall(input) }, scope: fixtureScope })) })
      .filter((check) => check.name === "long_term_memory.source-filter")
    const results = await Effect.runPromise(Effect.forEach(unfiltered, (check) => Effect.result(check.run), { concurrency: 1 }))
    expect(results.length === 1 && results.every(Result.isFailure)).toBe(true)
  })
})
