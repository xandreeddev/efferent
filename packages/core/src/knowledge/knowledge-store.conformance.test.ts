import { describe, expect, test } from "bun:test"
import { Effect, Match, Option, Ref, Result } from "effect"
import type { KnowledgeIndex } from "../ports/knowledge.port.js"
import { makeKnowledgeIndexMemory } from "./knowledge.memory.adapter.js"
import { admitsKnowledgeSource, knowledgeCandidateAdmitted } from "./knowledge.entity.functions.js"
import { knowledgeStoreConformance, temporalGraphConformance } from "./knowledge-store.conformance.js"
import { KnowledgeJobCursor, KnowledgeJobId, KnowledgeLeaseToken, KnowledgeSourceId, type KnowledgeCandidate, type KnowledgeClaim, type KnowledgeError, type KnowledgeJob, type KnowledgeScope, type KnowledgeSearch } from "./knowledge.entity.js"

const scope: KnowledgeScope = { owner: "test", namespace: "assistant", collection: "memory" }
const checks = knowledgeStoreConformance({ open: Effect.map(makeKnowledgeIndexMemory(), (index) => ({ index, scope })) })

describe("knowledge index reference conformance", () => {
  checks.forEach((check) => test(check.name, () => Effect.runPromise(check.run)))
  test("pins the checks provided to independent adapters", () => {
    expect(checks.map((check) => check.name)).toEqual([
      "knowledge.source-replay", "knowledge.lease-fencing", "knowledge.stage-retry", "knowledge.stage-notes", "knowledge.failure-reason",
      "knowledge.atomic-cas", "knowledge.exact-provenance", "knowledge.scope-isolation",
      "knowledge.hybrid-candidates", "knowledge.source-filter", "knowledge.metadata-filter", "knowledge.similarity-floor", "knowledge.forget-tombstone", "knowledge.supersession-links", "knowledge.supersede-support", "knowledge.mentions", "knowledge.event-time",
      "knowledge.corroboration", "knowledge.corroboration-conflict", "knowledge.corroboration-revision", "knowledge.corroboration-reach", "knowledge.corroboration-superseded", "knowledge.source-revision",
      "knowledge.immutable-chunk-identity", "knowledge.entity-forget-rebuild", "knowledge.forgotten-stage-privacy", "knowledge.unpublished-stage-privacy", "knowledge.pending-discovery",
      "knowledge.engine-isolation", "knowledge.failed-listing", "knowledge.requeue", "knowledge.source-info", "knowledge.bitemporal-change", "knowledge.bitemporal-traversal",
    ])
  })
})

const careless = Effect.map(makeKnowledgeIndexMemory(), (real): KnowledgeIndex => ({
  ...real,
  enqueue: (input) => Effect.succeed({ id: input.jobId, scope: input.source.scope, source: input.source.ref, engine: input.engine, attempt: 0, phase: { _tag: "Queued" }, stage: Option.none() }),
  claim: (input) => Effect.map(real.pending({ engine: "kit", namespace: input.scope.namespace, now: input.now, limit: 1 }), (jobs) => Option.map(Option.fromNullishOr(jobs[0]), (job): KnowledgeJob => ({ ...job, phase: { _tag: "Processing", token: KnowledgeLeaseToken.make("ignored"), worker: "careless", leaseUntil: 999 } }))),
  stage: () => Effect.void,
  publish: () => Effect.void,
  fail: () => Effect.void,
  forget: () => Effect.void,
}))

test("every contract check rejects a careless adapter that accepts but stores nothing", async () => {
  const broken = knowledgeStoreConformance({ open: Effect.map(careless, (index) => ({ index, scope })) })
  const results = await Effect.runPromise(Effect.forEach(broken, (check) => Effect.result(check.run), { concurrency: 1 }))
  expect(results.every(Result.isFailure)).toBe(true)
})

test("the graph kit rejects a separate view that ignores the backing index", async () => {
  const graphChecks = temporalGraphConformance({ open: Effect.map(makeKnowledgeIndexMemory(), (index) => ({ index, scope, graph: { traverse: () => Effect.succeed({ entities: [], assertions: [], truncated: false }) } })) })
  expect(graphChecks.map((check) => check.name)).toEqual(["knowledge.bitemporal-change", "knowledge.bitemporal-traversal"])
  const results = await Effect.runPromise(Effect.forEach(graphChecks, (check) => Effect.result(check.run), { concurrency: 1 }))
  expect(results.every(Result.isFailure)).toBe(true)
})

test("every check passes when all of them share one index, namespace and collection", async () => {
  const shared = await Effect.runPromise(makeKnowledgeIndexMemory())
  const owners = await Effect.runPromise(Ref.make(0))
  const sharing = knowledgeStoreConformance({ open: Effect.map(Ref.updateAndGet(owners, (count) => count + 1), (count) => ({ index: shared, scope: { ...scope, owner: `owner-${count}` } })) })
  const results = await Effect.runPromise(Effect.forEach(sharing, (check) => Effect.result(check.run), { concurrency: 1 }))
  expect(sharing.filter((_, index) => !Result.isSuccess(results[index]!)).map((check) => check.name)).toEqual([])
})

test("a store that claims jobs of any engine fails the engine isolation and requeue checks alone", async () => {
  const engineBlind = Effect.gen(function* () {
    const real = yield* makeKnowledgeIndexMemory()
    const engines = yield* Ref.make<ReadonlyArray<string>>([])
    const claimAny = (input: KnowledgeClaim, remaining: ReadonlyArray<string>): Effect.Effect<Option.Option<KnowledgeJob>, KnowledgeError> => remaining.length === 0
      ? Effect.succeed(Option.none())
      : real.claim({ ...input, engine: remaining[0]! }).pipe(Effect.flatMap((found) => Option.isSome(found) ? Effect.succeed(found) : claimAny(input, remaining.slice(1))))
    const index: KnowledgeIndex = {
      ...real,
      enqueue: (input) => Ref.update(engines, (all) => all.includes(input.engine) ? all : [...all, input.engine]).pipe(Effect.andThen(real.enqueue(input))),
      requeue: (input) => Ref.update(engines, (all) => all.includes(input.engine) ? all : [...all, input.engine]).pipe(Effect.andThen(real.requeue(input))),
      claim: (input) => Ref.get(engines).pipe(Effect.flatMap((all) => claimAny(input, all))),
    }
    return { index, scope }
  })
  const broken = knowledgeStoreConformance({ open: engineBlind })
  const results = await Effect.runPromise(Effect.forEach(broken, (check) => Effect.result(check.run), { concurrency: 1 }))
  expect(broken.filter((_, index) => Result.isFailure(results[index]!)).map((check) => check.name)).toEqual(["knowledge.engine-isolation", "knowledge.requeue"])
})

test("a store that stages corroborations without them fails the corroboration checks alone", async () => {
  const ignoring = Effect.map(makeKnowledgeIndexMemory(), (real): KnowledgeIndex => ({ ...real, stage: (lease, { corroborations: _ignored, ...stage }) => real.stage(lease, stage) }))
  const broken = knowledgeStoreConformance({ open: Effect.map(ignoring, (index) => ({ index, scope })) })
  const results = await Effect.runPromise(Effect.forEach(broken, (check) => Effect.result(check.run), { concurrency: 1 }))
  expect(broken.filter((_, index) => Result.isFailure(results[index]!)).map((check) => check.name)).toEqual(["knowledge.corroboration", "knowledge.corroboration-conflict", "knowledge.corroboration-revision", "knowledge.corroboration-reach"])
})

test("the corroboration-reach check rejects a store that narrows on every span or shows evidence from outside the reach", async () => {
  const narrowedOnly = (query: KnowledgeSearch) => query.sources !== undefined || query.metadata !== undefined
  // The rule before corroborations: every span must be admitted, so a restatement from outside hides the memory.
  const strict = Effect.map(makeKnowledgeIndexMemory(), (real): KnowledgeIndex => ({ ...real, search: (query) => Effect.gen(function* () {
    const found = yield* real.search(query)
    if (!narrowedOnly(query)) return found
    const corroborated = (candidate: KnowledgeCandidate) => candidate._tag === "Memory"
      ? real.memory(query.scope, candidate.memory.id).pipe(Effect.map((stored) => Option.exists(stored, (memory) => (memory.mentions ?? []).length > 1)))
      : Effect.succeed(false)
    const kept = (candidates: ReadonlyArray<KnowledgeCandidate>) => Effect.filter(candidates, (candidate) => Effect.map(corroborated(candidate), (hidden) => !hidden))
    return { lexical: yield* kept(found.lexical), semantic: yield* kept(found.semantic) }
  }) }))
  // Admits the right records but shows them whole, the restating source's spans and mention included.
  const leaky = Effect.map(makeKnowledgeIndexMemory(), (real): KnowledgeIndex => ({ ...real, search: (query) => Effect.gen(function* () {
    const found = yield* real.search(query)
    if (!narrowedOnly(query)) return found
    const { sources: _sources, metadata: _metadata, ...unnarrowed } = query
    const whole = yield* real.search(unnarrowed)
    const shown = (candidates: ReadonlyArray<KnowledgeCandidate>) => candidates.map((candidate) => candidate._tag !== "Memory" ? candidate
      : [...whole.lexical, ...whole.semantic].find((other) => other._tag === "Memory" && other.memory.id === candidate.memory.id) ?? candidate)
    return { lexical: shown(found.lexical), semantic: shown(found.semantic) }
  }) }))
  const failures = await Effect.runPromise(Effect.forEach([strict, leaky], (index) => {
    const reach = knowledgeStoreConformance({ open: Effect.map(index, (opened) => ({ index: opened, scope })) }).filter((check) => check.name === "knowledge.corroboration-reach")
    return Effect.forEach(reach, (check) => Effect.map(Effect.result(check.run), Result.isFailure), { concurrency: 1 })
  }, { concurrency: 1 }))
  expect(failures).toEqual([[true], [true]])
})

test("the source-filter check rejects a store that ignores the filter", async () => {
  const unfiltered = Effect.map(makeKnowledgeIndexMemory(), (real): KnowledgeIndex => ({ ...real, search: ({ sources: _ignored, ...query }) => real.search(query) }))
  const sourceFilter = knowledgeStoreConformance({ open: Effect.map(unfiltered, (index) => ({ index, scope })) }).filter((check) => check.name === "knowledge.source-filter")
  const results = await Effect.runPromise(Effect.forEach(sourceFilter, (check) => Effect.result(check.run), { concurrency: 1 }))
  expect(results.length === 1 && results.every(Result.isFailure)).toBe(true)
})

const failingAlone = async (name: string | ReadonlyArray<string>, change: (real: KnowledgeIndex) => Partial<KnowledgeIndex>) => {
  const changed = Effect.map(makeKnowledgeIndexMemory(), (real): KnowledgeIndex => ({ ...real, ...change(real) }))
  const all = knowledgeStoreConformance({ open: Effect.map(changed, (index) => ({ index, scope })) })
  const results = await Effect.runPromise(Effect.forEach(all, (check) => Effect.result(check.run), { concurrency: 1 }))
  expect(all.filter((_, index) => Result.isFailure(results[index]!)).map((check) => check.name)).toEqual(typeof name === "string" ? [name] : [...name])
}

test("the failed-listing check rejects a store that ignores the reason filter or lists every phase", async () => {
  await failingAlone("knowledge.failed-listing", (real) => ({ failed: ({ reasons: _ignored, ...query }) => real.failed(query) }))
  // Listing no failed job at all also loses the failure the failure-reason check lists.
  await failingAlone(["knowledge.failure-reason", "knowledge.failed-listing"], (real) => ({
    failed: (query) => real.pending({ engine: query.engine ?? "kit", namespace: query.namespace, now: 1_000, limit: query.limit }).pipe(Effect.map((jobs) => ({ jobs, next: Option.none() }))),
  }))
})

test("the failure-reason check rejects a store that drops a failure's diagnostic", async () => {
  await failingAlone("knowledge.failure-reason", (real) => ({ fail: (lease, { diagnostic: _dropped, ...failure }) => real.fail(lease, failure) }))
})

test("the requeue check rejects a store whose requeue keeps the job's attempts and engine", async () => {
  await failingAlone("knowledge.requeue", (real) => ({ requeue: (input) => real.retry(input.scope, input.jobId) }))
})

test("the reference store refuses a requeue onto an engine that already holds the revision, and a foreign cursor", async () => {
  const outcome = await Effect.runPromise(Effect.gen(function* () {
    const index = yield* makeKnowledgeIndexMemory()
    const source = { scope, ref: { id: KnowledgeSourceId.make("held"), revision: 1 }, text: "Held evidence", occurredAt: 1, recordedAt: 2, metadata: {} }
    const failed = yield* index.enqueue({ jobId: KnowledgeJobId.make("older"), source, engine: "older", expectedRevision: Option.none() })
    yield* index.enqueue({ jobId: KnowledgeJobId.make("current"), source, engine: "current", expectedRevision: Option.none() })
    const token = KnowledgeLeaseToken.make("token")
    yield* index.claim({ scope, engine: "older", worker: "test", token, now: 1, leaseMs: 10 })
    yield* index.fail({ scope, jobId: failed.id, token, now: 2 }, { reason: "Unavailable", message: "unreachable", step: "Required" })
    const held = yield* Effect.flip(index.requeue({ scope, jobId: failed.id, engine: "current" }))
    const cursor = yield* Effect.flip(index.failed({ namespace: scope.namespace, limit: 1, after: KnowledgeJobCursor.make("not-a-position") }))
    const listed = yield* index.failed({ namespace: scope.namespace, limit: 10 })
    return { held: held.reason, cursor: cursor.reason, listed: listed.jobs.map((job) => job.id) }
  }))
  expect(outcome).toEqual({ held: "Conflict", cursor: "Invalid", listed: [KnowledgeJobId.make("older")] })
})

test("the metadata-filter check rejects a store that ignores the filter or applies it after the limit", async () => {
  const ignoring = Effect.map(makeKnowledgeIndexMemory(), (real): KnowledgeIndex => ({ ...real, search: ({ metadata: _ignored, ...query }) => real.search(query) }))
  // Ranks unfiltered, keeps the nearest `limit`, then drops what the filter refuses: narrow scopes lose their matches.
  const afterLimit = Effect.map(makeKnowledgeIndexMemory(), (real): KnowledgeIndex => ({
    ...real,
    search: ({ metadata, ...query }) => real.search(query).pipe(Effect.flatMap((found) => metadata === undefined ? Effect.succeed(found) : Effect.gen(function* () {
      const admitted = (arm: typeof found.lexical) => Effect.filter(arm, (candidate) => Effect.map(
        Effect.forEach(Match.valueTags(candidate, { Memory: ({ memory }) => memory.provenance, Chunk: ({ chunk }) => [chunk.provenance] }), (span) => real.source(query.scope, span.source), { concurrency: 1 }),
        (sources) => knowledgeCandidateAdmitted(candidate, (ref) => sources.some((source) => Option.exists(source, (value) => value.ref.id === ref.id && value.ref.revision === ref.revision && admitsKnowledgeSource({ metadata }, value)))),
      ), { concurrency: 1 })
      return { lexical: yield* admitted(found.lexical), semantic: yield* admitted(found.semantic) }
    }))),
  }))
  const results = await Effect.runPromise(Effect.forEach([ignoring, afterLimit], (open) => Effect.forEach(
    knowledgeStoreConformance({ open: Effect.map(open, (index) => ({ index, scope })) }).filter((check) => check.name === "knowledge.metadata-filter"),
    (check) => Effect.result(check.run), { concurrency: 1 },
  ), { concurrency: 1 }))
  expect(results.map((found) => found.length === 1 && found.every(Result.isFailure))).toEqual([true, true])
})

test("the similarity-floor check rejects a store that ignores the floor, floors the lexical arm too, or scores by anything but cosine", async () => {
  await failingAlone("knowledge.similarity-floor", (real) => ({ search: ({ minSimilarity: _ignored, ...query }) => real.search(query) }))
  await failingAlone("knowledge.similarity-floor", (real) => ({
    search: (query) => real.search(query).pipe(Effect.map((found) => query.minSimilarity === undefined ? found : { ...found, lexical: found.lexical.filter((candidate) => candidate.score >= 10) })),
  }))
  await failingAlone("knowledge.similarity-floor", (real) => ({
    search: (query) => real.search(query).pipe(Effect.map((found) => ({ ...found, semantic: found.semantic.map((candidate) => ({ ...candidate, score: candidate.score * candidate.score })) }))),
  }))
})
