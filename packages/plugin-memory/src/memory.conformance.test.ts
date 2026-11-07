import { describe, expect, test } from "bun:test"
import { Effect, Option, Order, Redacted, Result } from "effect"
import type { Scope } from "effect"
import { KnowledgeJobId, KnowledgeSourceId } from "@xandreed/core"
import type { KnowledgeIndex, KnowledgeScope } from "@xandreed/core"
import { longTermMemoryConformance } from "@xandreed/core/conformance"
import { makeKnowledgePostgres } from "@xandreed/plugin-knowledge-postgres"
import { fixtureExtraction, fixtureScope, makeMemoryFixture } from "./memory.testing.js"

const postgresUrl = process.env.EFFERENT_TEST_POSTGRES_URL ?? ""

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
/** The kit's source, its preference tied to an event long past (the source is dated at epoch 1). */
const pastEvent = makeMemoryFixture([JSON.stringify({ ...grounded, memories: grounded.memories.map((memory) => ({ ...memory, eventAt: { start: 5, end: null } })) })])
const checks = longTermMemoryConformance({
  open: Effect.map(open, ({ memory }) => ({ memory, scope: fixtureScope })),
  droppingExtraction: Effect.map(dropping, ({ memory }) => ({ memory, scope: fixtureScope })),
  restatingExtraction: Effect.map(restating, ({ memory }) => ({ memory, scope: fixtureScope })),
  pastEventExtraction: Effect.map(pastEvent, ({ memory }) => ({ memory, scope: fixtureScope })),
})

/** The engine over a PostgreSQL memory store, in a scope of its own: the database is shared across checks and runs. */
const overPostgres = <A, E>(make: (index: KnowledgeIndex, scope: KnowledgeScope) => Effect.Effect<A, E, Scope.Scope>) => Effect.gen(function* () {
  const opened = yield* makeKnowledgePostgres(Redacted.make(postgresUrl))
  return yield* make(opened.memory, { ...fixtureScope, owner: `postgres-${crypto.randomUUID()}` })
})
const postgresChecks = longTermMemoryConformance({
  open: overPostgres((index, scope) => Effect.map(makeMemoryFixture([JSON.stringify(fixtureExtraction("I prefer tea."))], {}, index), ({ memory }) => ({ memory, scope }))),
})

describe("native memory facade conformance", () => {
  checks.forEach((check) => test(check.name, () => Effect.runPromise(check.run)))
  postgresChecks.forEach((check) => test.skipIf(postgresUrl.length === 0)(`PostgreSQL: ${check.name}`, () => Effect.runPromise(check.run)))
  test("the profile-order check fails on a profile in the store's order, and on one that leaves out support", async () => {
    const order = (memory: Parameters<typeof longTermMemoryConformance>[0]["open"]) => longTermMemoryConformance({ open: memory }).filter((check) => check.name === "long_term_memory.profile-order")
    // The store's own order: insertion order here, and the order a store that sorts by id would keep.
    const inserted = Effect.map(open, ({ memory, store }) => ({ scope: fixtureScope, memory: { ...memory, profile: (scope: typeof fixtureScope) => store.snapshot(scope).pipe(
      Effect.map((snapshot) => snapshot.memories.filter((record) => Option.isNone(record.knownTo)))) } }))
    const byId = Effect.map(open, ({ memory }) => ({ scope: fixtureScope, memory: { ...memory, profile: (scope: typeof fixtureScope) => memory.profile(scope).pipe(
      Effect.map((records) => records.toSorted((left, right) => Order.String(left.id, right.id)))) } }))
    const unsupported = Effect.map(open, ({ memory }) => ({ scope: fixtureScope, memory: { ...memory, profile: (scope: typeof fixtureScope) => memory.profile(scope).pipe(
      Effect.map((records) => records.map(({ support: _support, ...record }) => record))) } }))
    const results = await Effect.runPromise(Effect.forEach([...order(inserted), ...order(byId), ...order(unsupported)], (check) => Effect.result(check.run), { concurrency: 1 }))
    expect(results.map(Result.isFailure)).toEqual([true, true, true])
  })
  test.skipIf(postgresUrl.length === 0)("the same sources give the same profile order on the in-memory store and on PostgreSQL, whatever order each keeps", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    // Accepted in neither id order nor the order they were said; the latest said leads, and a tie goes to the lower id.
    const said = [["profile-b", 30], ["profile-a", 10], ["profile-d", 20], ["profile-c", 20]] as const
    const profileOf = (fixture: Effect.Success<ReturnType<typeof makeMemoryFixture>>, scope: KnowledgeScope) => Effect.gen(function* () {
      yield* Effect.forEach(said, ([name, occurredAt]) => fixture.memory.capture({
        jobId: KnowledgeJobId.make(`job:${name}`), engine: "memory:1", expectedRevision: Option.none(),
        source: { scope, ref: { id: KnowledgeSourceId.make(name), revision: 1 }, text: "I prefer tea.", occurredAt, recordedAt: 40, metadata: {} },
      }), { concurrency: 1 })
      expect(yield* fixture.memory.process(scope, 10)).toBe(4)
      return (yield* fixture.memory.profile(scope)).map((memory) => [String(memory.provenance[0]?.source.id), memory.support?.lastSeen])
    })
    const response = [JSON.stringify(fixtureExtraction("I prefer tea."))]
    const inMemory = yield* makeMemoryFixture(response).pipe(Effect.flatMap((fixture) => profileOf(fixture, fixtureScope)))
    const postgres = yield* overPostgres((index, scope) => makeMemoryFixture(response, {}, index).pipe(Effect.flatMap((fixture) => profileOf(fixture, scope))))
    expect(inMemory).toEqual([["profile-b", 30], ["profile-c", 20], ["profile-d", 20], ["profile-a", 10]])
    expect(postgres).toEqual(inMemory)
  }))))
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
  test("the past-event check fails when the profile keeps a past preference, or recall drops or does not mark it", async () => {
    const past = (memory: Parameters<typeof longTermMemoryConformance>[0]["open"]) => longTermMemoryConformance({ open: Effect.map(open, ({ memory }) => ({ memory, scope: fixtureScope })), pastEventExtraction: memory })
      .filter((check) => check.name === "long_term_memory.past-event")
    const keeping = Effect.map(pastEvent, ({ memory }) => ({ memory: { ...memory, profile: (scope: typeof fixtureScope) => memory.recall({ scope, query: "tea", limit: 10, maxChars: 1000, graph: false }).pipe(
      Effect.map((result) => result.candidates.flatMap((candidate) => candidate._tag === "Memory" ? [candidate.memory] : []))) }, scope: fixtureScope }))
    const unmarked = Effect.map(pastEvent, ({ memory }) => ({ memory: { ...memory, recall: (input: Parameters<typeof memory.recall>[0]) => memory.recall(input).pipe(
      Effect.map((result) => ({ ...result, candidates: result.candidates.map((candidate) => candidate._tag === "Memory" ? { ...candidate, past: false } : candidate) }))) }, scope: fixtureScope }))
    const results = await Effect.runPromise(Effect.forEach([...past(keeping), ...past(unmarked)], (check) => Effect.result(check.run), { concurrency: 1 }))
    expect(results.map(Result.isFailure)).toEqual([true, true])
  })
})
