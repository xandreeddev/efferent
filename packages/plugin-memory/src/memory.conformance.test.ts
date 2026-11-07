import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { longTermMemoryConformance } from "@xandreed/core/conformance"
import { fixtureExtraction, fixtureScope, makeMemoryFixture } from "./memory.testing.js"

const open = makeMemoryFixture([JSON.stringify(fixtureExtraction("I prefer tea."))])
const grounded = fixtureExtraction("I prefer tea.")
/** The grounded records, and a memory about an entity the extraction never defines. */
const dropping = makeMemoryFixture([JSON.stringify({ ...grounded, memories: [...grounded.memories, { ...grounded.memories[0]!, key: "stranger", entities: ["stranger"] }] })])
/** The kit's source as usual; the second source names the first one's memory, read from its candidates, as the memory it restates. */
const restating = makeMemoryFixture((prompt) => {
  const text = /<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? ""
  const candidates = /<knowledge-candidates>\n([\s\S]*?)\n<\/knowledge-candidates>/.exec(prompt)?.[1] ?? "{}"
  const earlier = /"id":"([^"]*:memory:[^"]*)"/.exec(candidates)?.[1]
  const extracted = fixtureExtraction(text)
  return JSON.stringify(earlier === undefined ? extracted : { ...extracted, memories: extracted.memories.map((memory) => ({ ...memory, restates: [earlier] })) })
})
const checks = longTermMemoryConformance({
  open: Effect.map(open, ({ memory }) => ({ memory, scope: fixtureScope })),
  droppingExtraction: Effect.map(dropping, ({ memory }) => ({ memory, scope: fixtureScope })),
  restatingExtraction: Effect.map(restating, ({ memory }) => ({ memory, scope: fixtureScope })),
})

describe("native memory facade conformance", () => {
  checks.forEach((check) => test(check.name, () => Effect.runPromise(check.run)))
  test("the source-filter check rejects recall that ignores the filter", async () => {
    const unfiltered = longTermMemoryConformance({ open: Effect.map(open, ({ memory }) => ({ memory: { ...memory, recall: ({ sources: _ignored, ...input }) => memory.recall(input) }, scope: fixtureScope })) })
      .filter((check) => check.name === "long_term_memory.source-filter")
    const results = await Effect.runPromise(Effect.forEach(unfiltered, (check) => Effect.result(check.run), { concurrency: 1 }))
    expect(results.length === 1 && results.every(Result.isFailure)).toBe(true)
  })
  test("the restated-source check passes on plain extraction without a restating one, and fails when a restating extraction restates nothing", async () => {
    const restated = (subject: Parameters<typeof longTermMemoryConformance>[0]) => longTermMemoryConformance(subject).filter((check) => check.name === "long_term_memory.restated-source")
    const plain = { open: Effect.map(open, ({ memory }) => ({ memory, scope: fixtureScope })) }
    const results = await Effect.runPromise(Effect.forEach([...restated(plain), ...restated({ ...plain, restatingExtraction: plain.open })], (check) => Effect.result(check.run), { concurrency: 1 }))
    expect(results.map(Result.isSuccess)).toEqual([true, false])
  })
})
