import { expect, test } from "bun:test"
import postgres from "postgres"
import { Effect, Option, Redacted, Result } from "effect"
import {
  KnowledgeAssertionId, KnowledgeChunkId, KnowledgeEntityId, KnowledgeJobId, KnowledgeLeaseToken, KnowledgeMemoryId, KnowledgeSourceId,
} from "@xandreed/core"
import type { KnowledgeIndex, KnowledgeMemory, KnowledgeScope, KnowledgeSource, KnowledgeStage } from "@xandreed/core"
import { knowledgeStoreConformance, memoryStoreConformance } from "@xandreed/core/conformance"
import { makeKnowledgePostgres } from "./plugin.adapter.js"

const url = process.env.EFFERENT_TEST_POSTGRES_URL ?? ""
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const freshScope = (): KnowledgeScope => {
  const identity = crypto.randomUUID()
  return { owner: `postgres-test-${identity}`, namespace: `integration-${identity}`, collection: "native" }
}
const stores = [
  { name: "memory", kit: memoryStoreConformance, select: (opened: Effect.Success<ReturnType<typeof makeKnowledgePostgres>>) => opened.memory },
  { name: "knowledge", kit: knowledgeStoreConformance, select: (opened: Effect.Success<ReturnType<typeof makeKnowledgePostgres>>) => opened.knowledge },
]

stores.forEach(({ name, kit, select }) => kit({
  open: Effect.gen(function* () {
    const opened = yield* makeKnowledgePostgres(Redacted.make(url))
    return { index: select(opened), scope: freshScope() }
  }),
}).forEach((check) => test.skipIf(url.length === 0)(`PostgreSQL ${name}: ${check.name}`, () => run(check.run))))

const sourceOf = (scope: KnowledgeScope, id: string, text: string, revision = 1): KnowledgeSource => ({
  scope, ref: { id: KnowledgeSourceId.make(id), revision }, text, occurredAt: 10, recordedAt: 20, metadata: {},
})
const memoryOf = (source: KnowledgeSource, id: string, supports: ReadonlyArray<string> = []): KnowledgeMemory => ({
  id: KnowledgeMemoryId.make(id), kind: "fact", text: source.text,
  provenance: [{ source: source.ref, start: 0, end: source.text.length, quote: source.text }],
  entities: [], evidence: supports.length ? { _tag: "Inferred", supports: supports.map((id) => KnowledgeMemoryId.make(id)) } : { _tag: "Stated" },
  embedding: Option.some({ space: { model: "integration", version: "1", dimensions: 2 }, values: [1, 0] }),
  knownFrom: 21, knownTo: Option.none(),
})
const stageOf = (version: number, memories: ReadonlyArray<KnowledgeMemory> = []): KnowledgeStage => ({
  expectedVersion: version, memories, chunks: [], entities: [], assertions: [], retireMemories: [], retireAssertions: [],
})
const prepare = Effect.fnUntraced(function* (index: KnowledgeIndex, source: KnowledgeSource, stage: KnowledgeStage, expectedRevision = Option.none<number>()) {
  const job = yield* index.enqueue({ source, jobId: KnowledgeJobId.make(`job-${source.ref.id}-${source.ref.revision}`), engine: "integration", expectedRevision })
  const token = KnowledgeLeaseToken.make(`token-${job.id}`)
  yield* index.claim({ scope: source.scope, engine: "integration", jobId: job.id, worker: "integration", token, now: 20, leaseMs: 1000 })
  const lease = { scope: source.scope, jobId: job.id, token, now: 22 }
  yield* index.stage(lease, stage)
  return lease
})

test.skipIf(url.length === 0)("PostgreSQL staging survives a closed pool and a second process handle", () => run(Effect.gen(function* () {
  const scope = freshScope()
  const source = sourceOf(scope, "recoverable", "A durable source")
  const lease = yield* Effect.scoped(Effect.gen(function* () {
    const store = yield* makeKnowledgePostgres(Redacted.make(url))
    return yield* prepare(store.memory, source, stageOf(0, [memoryOf(source, "recovered")]))
  }))
  yield* Effect.scoped(Effect.gen(function* () {
    const store = yield* makeKnowledgePostgres(Redacted.make(url))
    const pending = yield* store.memory.status(scope, lease.jobId)
    expect(Option.isSome(pending) && Option.isSome(pending.value.stage)).toBe(true)
    yield* store.memory.publish(lease)
    yield* store.memory.publish(lease)
    expect((yield* store.memory.snapshot(scope)).version).toBe(1)
    expect(Option.isSome(yield* store.memory.memory(scope, KnowledgeMemoryId.make("recovered")))).toBe(true)
  }))
})))

test.skipIf(url.length === 0)("PostgreSQL replacement is atomic and stale chunk identities remain fenced", () => run(Effect.scoped(Effect.gen(function* () {
  const { knowledge: index } = yield* makeKnowledgePostgres(Redacted.make(url))
  const scope = freshScope()
  const first = sourceOf(scope, "document", "The original source")
  const oldChunk = { id: KnowledgeChunkId.make("old-chunk"), text: first.text, provenance: { source: first.ref, start: 0, end: first.text.length, quote: first.text }, embedding: Option.none() }
  const initial = yield* prepare(index, first, { ...stageOf(0), chunks: [oldChunk] })
  yield* index.publish(initial)
  const second = sourceOf(scope, "document", "The replacement source", 2)
  const newChunk = { ...oldChunk, id: KnowledgeChunkId.make("new-chunk"), text: second.text, provenance: { source: second.ref, start: 0, end: second.text.length, quote: second.text } }
  const replacement = yield* prepare(index, second, { ...stageOf(1), chunks: [newChunk] }, Option.some(1))
  expect(Option.isSome(yield* index.chunk(scope, oldChunk.id))).toBe(true)
  expect(Option.isNone(yield* index.chunk(scope, newChunk.id))).toBe(true)
  yield* index.publish(replacement)
  expect(Option.isNone(yield* index.chunk(scope, oldChunk.id))).toBe(true)
  expect(Option.isSome(yield* index.source(scope, first.ref))).toBe(true)
  const other = sourceOf(scope, "other-document", first.text)
  const reused = yield* prepare(index, other, { ...stageOf(2), chunks: [{ ...oldChunk, provenance: { ...oldChunk.provenance, source: other.ref } }] })
  const refusal = yield* Effect.result(index.publish(reused))
  expect(Result.isFailure(refusal) && refusal.failure.reason).toBe("Conflict")
  expect((yield* index.snapshot(scope)).version).toBe(2)
  expect(Option.isSome(yield* index.chunk(scope, newChunk.id))).toBe(true)
}))))

test.skipIf(url.length === 0)("PostgreSQL forgetting cascades across inferred evidence without crossing owners", () => run(Effect.scoped(Effect.gen(function* () {
  const { memory: index } = yield* makeKnowledgePostgres(Redacted.make(url))
  const scope = freshScope()
  const first = sourceOf(scope, "primary", "Alice likes morning meetings")
  const second = sourceOf(scope, "secondary", "Alice starts early")
  const third = sourceOf(scope, "tertiary", "Alice is available before lunch")
  yield* index.publish(yield* prepare(index, first, stageOf(0, [memoryOf(first, "first")])))
  yield* index.publish(yield* prepare(index, second, stageOf(1, [memoryOf(second, "second", ["first"])])))
  yield* index.publish(yield* prepare(index, third, stageOf(2, [memoryOf(third, "third", ["second"])])))
  const stranger = { ...scope, owner: `${scope.owner}-stranger` }
  yield* index.forget(stranger, first.ref.id, 40)
  expect((yield* index.snapshot(scope)).memories.length).toBe(3)
  yield* index.forget(scope, first.ref.id, 50)
  expect((yield* index.snapshot(scope)).memories).toHaveLength(0)
  expect(Option.isSome(yield* index.source(scope, second.ref))).toBe(true)
  const secondJob = yield* index.status(scope, KnowledgeJobId.make("job-secondary-1"))
  const thirdJob = yield* index.status(scope, KnowledgeJobId.make("job-tertiary-1"))
  expect(Option.isSome(secondJob) && secondJob.value.phase._tag === "Queued" && Option.isNone(secondJob.value.stage)).toBe(true)
  expect(Option.isSome(thirdJob) && thirdJob.value.phase._tag === "Queued" && Option.isNone(thirdJob.value.stage)).toBe(true)
  const version = (yield* index.snapshot(scope)).version
  yield* index.forget(scope, first.ref.id, 60)
  expect((yield* index.snapshot(scope)).version).toBe(version)
  yield* index.publish(yield* prepare(index, second, stageOf(version, [memoryOf(second, "second")])))
  yield* index.publish(yield* prepare(index, third, stageOf(version + 1, [memoryOf(third, "third", ["second"])])))
  expect((yield* index.snapshot(scope)).memories).toHaveLength(2)
}))))

test.skipIf(url.length === 0)("PostgreSQL lease races are fenced across two independent pools", () => run(Effect.scoped(Effect.gen(function* () {
  const first = yield* makeKnowledgePostgres(Redacted.make(url))
  const second = yield* makeKnowledgePostgres(Redacted.make(url))
  const scope = freshScope()
  const source = sourceOf(scope, "race", "Only one worker may publish")
  const job = yield* first.memory.enqueue({ jobId: KnowledgeJobId.make("race-job"), source, engine: "integration", expectedRevision: Option.none() })
  const claims = yield* Effect.all([
    first.memory.claim({ scope, engine: "integration", worker: "one", token: KnowledgeLeaseToken.make("one"), now: 10, leaseMs: 10 }),
    second.memory.claim({ scope, engine: "integration", worker: "two", token: KnowledgeLeaseToken.make("two"), now: 10, leaseMs: 10 }),
  ], { concurrency: 2 })
  expect(claims.filter(Option.isSome)).toHaveLength(1)
  const takeover = yield* second.memory.claim({ scope, engine: "integration", worker: "three", token: KnowledgeLeaseToken.make("three"), now: 21, leaseMs: 100 })
  expect(Option.isSome(takeover)).toBe(true)
  const stale = yield* Effect.result(first.memory.publish({ scope, jobId: job.id, token: KnowledgeLeaseToken.make("one"), now: 22 }))
  expect(Result.isFailure(stale) && stale.failure.reason).toBe("LeaseLost")
}))))

test.skipIf(url.length === 0)("PostgreSQL memory and RAG domains remain independently bindable", () => run(Effect.scoped(Effect.gen(function* () {
  const store = yield* makeKnowledgePostgres(Redacted.make(url))
  const scope = freshScope()
  const source = sourceOf(scope, "shared-id", "An isolated source")
  yield* store.memory.publish(yield* prepare(store.memory, source, stageOf(0, [memoryOf(source, "memory")])) )
  expect((yield* store.knowledge.snapshot(scope)).version).toBe(0)
  expect(Option.isNone(yield* store.knowledge.source(scope, source.ref))).toBe(true)
}))))

test.skipIf(url.length === 0)("PostgreSQL stamps observation time at publication and decodes damaged rows", () => run(Effect.scoped(Effect.gen(function* () {
  const { memory: index } = yield* makeKnowledgePostgres(Redacted.make(url))
  const sql = yield* Effect.acquireRelease(Effect.sync(() => postgres(url)), (connection) => Effect.tryPromise(() => connection.end()).pipe(Effect.orDie))
  const scope = freshScope()
  const source = sourceOf(scope, "timestamp", "The source was observed")
  const lease = yield* prepare(index, source, stageOf(0, [{ ...memoryOf(source, "timestamp-memory"), knownFrom: 0 }]))
  yield* index.publish(lease)
  const memory = yield* index.memory(scope, KnowledgeMemoryId.make("timestamp-memory"))
  expect(Option.isSome(memory) && memory.value.knownFrom).toBe(lease.now)
  yield* Effect.tryPromise(() => sql`UPDATE efferent_knowledge.memories SET payload='{"damaged":true}'::jsonb
    WHERE domain='memory' AND owner=${scope.owner} AND namespace=${scope.namespace} AND collection=${scope.collection} AND id='timestamp-memory'`)
  const failed = yield* Effect.result(index.memory(scope, KnowledgeMemoryId.make("timestamp-memory")))
  expect(Result.isFailure(failed) && failed.failure.reason).toBe("Corrupt")
}))))

test.skipIf(url.length === 0)("PostgreSQL keeps a failed job's reason in its payload and decodes one stored before reasons", () => run(Effect.scoped(Effect.gen(function* () {
  const { knowledge: index } = yield* makeKnowledgePostgres(Redacted.make(url))
  const sql = yield* Effect.acquireRelease(Effect.sync(() => postgres(url)), (connection) => Effect.tryPromise(() => connection.end()).pipe(Effect.orDie))
  const scope = freshScope()
  const source = sourceOf(scope, "failed", "The extraction failed")
  const lease = yield* prepare(index, source, stageOf(0))
  yield* index.fail(lease, { reason: "Invalid", message: "the graph extraction was invalid", step: "Graph" })
  const failed = yield* index.status(scope, lease.jobId)
  expect(Option.map(failed, (job) => job.phase)).toEqual(Option.some({ _tag: "Failed", reason: "Invalid", message: "the graph extraction was invalid", step: "Graph" }))
  const where = sql`domain='knowledge' AND owner=${scope.owner} AND namespace=${scope.namespace} AND collection=${scope.collection} AND id=${lease.jobId}`
  const [row] = yield* Effect.tryPromise(() => sql<ReadonlyArray<{ readonly phase: string }>>`SELECT phase FROM efferent_knowledge.jobs WHERE ${where}`)
  expect(row?.phase).toBe("Failed")
  yield* Effect.tryPromise(() => sql`UPDATE efferent_knowledge.jobs SET payload = payload #- '{phase,reason}' #- '{phase,step}' WHERE ${where}`)
  const older = yield* index.status(scope, lease.jobId)
  expect(Option.map(older, (job) => job.phase)).toEqual(Option.some({ _tag: "Failed", reason: "Unavailable", message: "the graph extraction was invalid", step: "Required" }))
  expect((yield* index.retry(scope, lease.jobId)).phase._tag).toBe("Queued")
}))))

test.skipIf(url.length === 0)("PostgreSQL scope CAS permits one concurrent publication across pools", () => run(Effect.scoped(Effect.gen(function* () {
  const first = yield* makeKnowledgePostgres(Redacted.make(url))
  const second = yield* makeKnowledgePostgres(Redacted.make(url))
  const scope = freshScope()
  const sourceA = sourceOf(scope, "cas-a", "First independent fact")
  const sourceB = sourceOf(scope, "cas-b", "Second independent fact")
  const leaseA = yield* prepare(first.memory, sourceA, stageOf(0, [memoryOf(sourceA, "cas-a")]))
  const leaseB = yield* prepare(second.memory, sourceB, stageOf(0, [memoryOf(sourceB, "cas-b")]))
  const results = yield* Effect.all([
    Effect.result(first.memory.publish(leaseA)), Effect.result(second.memory.publish(leaseB)),
  ], { concurrency: 2 })
  expect(results.filter(Result.isSuccess)).toHaveLength(1)
  expect(results.filter(Result.isFailure)).toHaveLength(1)
  const snapshot = yield* first.memory.snapshot(scope)
  expect(snapshot.version).toBe(1)
  expect(snapshot.memories).toHaveLength(1)
}))))

test.skipIf(url.length === 0)("PostgreSQL chunk vectors enforce profile identity and define zero-norm scores", () => run(Effect.scoped(Effect.gen(function* () {
  const { knowledge: index } = yield* makeKnowledgePostgres(Redacted.make(url))
  const scope = freshScope()
  const source = sourceOf(scope, "zero", "A vector-backed source")
  const vector = { space: { model: "integration", version: "1", dimensions: 2 }, values: [0, 0] }
  const chunk = { id: KnowledgeChunkId.make("zero-chunk"), text: source.text,
    provenance: { source: source.ref, start: 0, end: source.text.length, quote: source.text }, embedding: Option.some(vector) }
  yield* index.publish(yield* prepare(index, source, { ...stageOf(0), chunks: [chunk] }))
  const query = { scope, query: "unrelated", vector: Option.some(vector), limit: 10, knownAt: Option.none<number>() }
  const found = yield* index.search(query)
  expect(found.semantic).toHaveLength(1)
  expect(found.semantic[0]?.score).toBe(0)
  const incompatible = yield* Effect.result(index.search({ ...query, vector: Option.some({ ...vector, space: { ...vector.space, version: "2" } }) }))
  expect(Result.isFailure(incompatible) && incompatible.failure.reason).toBe("EmbeddingMismatch")
}))))

test.skipIf(url.length === 0)("PostgreSQL pending discovery filters collections before its batch limit", () => run(Effect.scoped(Effect.gen(function* () {
  const { memory: index } = yield* makeKnowledgePostgres(Redacted.make(url))
  const scope = freshScope()
  const foreign = sourceOf({ ...scope, collection: "another-collection" }, "first", "Earlier work for another collection")
  const own = sourceOf(scope, "second", "Later work for this collection")
  yield* index.enqueue({ source: foreign, jobId: KnowledgeJobId.make("foreign"), engine: "integration", expectedRevision: Option.none() })
  const job = yield* index.enqueue({ source: own, jobId: KnowledgeJobId.make("own"), engine: "integration", expectedRevision: Option.none() })
  const pending = yield* index.pending({ namespace: scope.namespace, collection: scope.collection, engine: "integration", now: 0, limit: 1 })
  expect(pending.map((entry) => entry.id)).toEqual([job.id])
}))))

test.skipIf(url.length === 0)("PostgreSQL forgetting clears historical job stages that cite forgotten evidence", () => run(Effect.scoped(Effect.gen(function* () {
  const { memory: index } = yield* makeKnowledgePostgres(Redacted.make(url))
  const scope = freshScope()
  const original = sourceOf(scope, "original", "Alice likes coffee")
  const initialMemory = memoryOf(original, "original-memory")
  yield* index.publish(yield* prepare(index, original, stageOf(0, [initialMemory])))
  const historical = sourceOf(scope, "survivor", "Alice starts early")
  const inferred = { ...memoryOf(historical, "historical-memory", ["original-memory"]), provenance: [...memoryOf(historical, "historical-memory").provenance, ...initialMemory.provenance] }
  const pastLease = yield* prepare(index, historical, stageOf(1, [inferred]))
  yield* index.publish(pastLease)
  const current = sourceOf(scope, "survivor", "Alice prefers quiet offices", 2)
  const currentLease = yield* prepare(index, current, stageOf(2, [memoryOf(current, "current-memory")]), Option.some(1))
  yield* index.publish(currentLease)
  expect(Option.exists(yield* index.status(scope, pastLease.jobId), (job) => Option.isSome(job.stage))).toBe(true)
  yield* index.forget(scope, original.ref.id, 50)
  const pastJob = yield* index.status(scope, pastLease.jobId)
  const currentJob = yield* index.status(scope, currentLease.jobId)
  expect(Option.isSome(pastJob) && pastJob.value.phase._tag === "Complete" && Option.isNone(pastJob.value.stage)).toBe(true)
  expect(Option.isSome(currentJob) && currentJob.value.phase._tag === "Queued" && Option.isNone(currentJob.value.stage)).toBe(true)
  expect(Option.isSome(yield* index.source(scope, historical.ref))).toBe(true)
}))))

test.skipIf(url.length === 0)("PostgreSQL forgetting physically purges affected indexed payloads while retaining rebuild fences", () => run(Effect.scoped(Effect.gen(function* () {
  const { memory: index } = yield* makeKnowledgePostgres(Redacted.make(url))
  const sql = yield* Effect.acquireRelease(Effect.sync(() => postgres(url)), (connection) => Effect.tryPromise(() => connection.end()).pipe(Effect.orDie))
  const scope = freshScope()
  const first = sourceOf(scope, "private", "Alice drinks coffee")
  const second = sourceOf(scope, "survivor", "Alice starts early")
  const entityId = KnowledgeEntityId.make("alice")
  const firstMemory = { ...memoryOf(first, "primary-memory"), entities: [entityId] }
  const firstChunk = { id: KnowledgeChunkId.make("private-chunk"), text: first.text, provenance: firstMemory.provenance[0]!, embedding: firstMemory.embedding }
  const firstAssertion = {
    id: KnowledgeAssertionId.make("private-assertion"), subject: entityId, predicate: "drinks", object: { _tag: "Value" as const, value: "coffee" }, text: first.text,
    provenance: firstMemory.provenance, validFrom: Option.none<number>(), validTo: Option.none<number>(), knownFrom: 20, knownTo: Option.none<number>(),
  }
  yield* index.publish(yield* prepare(index, first, {
    ...stageOf(0, [firstMemory]), chunks: [firstChunk], assertions: [firstAssertion],
    entities: [{ id: entityId, name: "Alice", type: "person", aliases: [], provenance: [{ source: first.ref, start: 0, end: 5, quote: "Alice" }] }],
  }))
  const secondMemory = { ...memoryOf(second, "secondary-memory", [firstMemory.id]), entities: [entityId] }
  const secondChunk = { id: KnowledgeChunkId.make("survivor-chunk"), text: second.text, provenance: secondMemory.provenance[0]!, embedding: secondMemory.embedding }
  const secondAssertion = { ...firstAssertion, id: KnowledgeAssertionId.make("survivor-assertion"), predicate: "starts", text: second.text, object: { _tag: "Value" as const, value: "early" }, provenance: secondMemory.provenance }
  yield* index.publish(yield* prepare(index, second, { ...stageOf(1, [secondMemory]), chunks: [secondChunk], assertions: [secondAssertion] }))
  yield* index.forget(scope, first.ref.id, 50)
  const counts = yield* Effect.forEach(["memories", "assertions", "entities", "chunks", "record_sources", "memory_supports"], (table) => Effect.tryPromise(() => sql.unsafe(
    `SELECT count(*)::int AS count FROM efferent_knowledge.${table} WHERE domain=$1 AND owner=$2 AND namespace=$3 AND collection=$4`,
    ["memory", scope.owner, scope.namespace, scope.collection],
  )).pipe(Effect.map((rows) => rows[0]?.count)), { concurrency: 1 })
  expect(counts).toEqual([0, 0, 0, 0, 0, 0])
  const fences = yield* Effect.tryPromise(() => sql`SELECT count(*)::int AS count FROM efferent_knowledge.identities WHERE domain='memory'
    AND owner=${scope.owner} AND namespace=${scope.namespace} AND collection=${scope.collection}`)
  expect(fences[0]?.count).toBe(6)
  expect(Option.isNone(yield* index.source(scope, first.ref))).toBe(true)
  expect(Option.isSome(yield* index.source(scope, second.ref))).toBe(true)
  yield* index.publish(yield* prepare(index, second, { ...stageOf(3, [memoryOf(second, secondMemory.id)]), chunks: [secondChunk] }))
  expect(Option.isSome(yield* index.memory(scope, secondMemory.id))).toBe(true)
  expect(Option.isSome(yield* index.chunk(scope, secondChunk.id))).toBe(true)
}))))

test.skipIf(url.length === 0)("PostgreSQL forgetting removes inherited evidence from unpublished staged jobs", () => run(Effect.scoped(Effect.gen(function* () {
  const { memory: index } = yield* makeKnowledgePostgres(Redacted.make(url))
  const scope = freshScope()
  const original = sourceOf(scope, "original", "Alice likes coffee")
  const supporting = memoryOf(original, "original-memory")
  yield* index.publish(yield* prepare(index, original, stageOf(0, [supporting])))
  const survivor = sourceOf(scope, "unpublished", "Alice starts early")
  const inferred = { ...memoryOf(survivor, "unpublished-memory", [supporting.id]), provenance: [...memoryOf(survivor, "unpublished-memory").provenance, ...supporting.provenance] }
  const staged = stageOf(1, [inferred])
  const lease = yield* prepare(index, survivor, staged)
  expect(Option.exists(yield* index.status(scope, lease.jobId), (job) => Option.isSome(job.stage))).toBe(true)
  yield* index.forget(scope, original.ref.id, 50)
  const job = yield* index.status(scope, lease.jobId)
  expect(Option.isSome(job) && Option.isNone(job.value.stage)).toBe(true)
  expect(Option.isSome(job) && job.value.phase._tag).toBe("Processing")
  expect(Option.isSome(yield* index.source(scope, survivor.ref))).toBe(true)
  const stale = yield* Effect.result(index.stage({ ...lease, now: 51 }, staged))
  expect(Result.isFailure(stale) && stale.failure.reason).toBe("Conflict")
  const restored = yield* Effect.result(index.stage({ ...lease, now: 51 }, { ...staged, expectedVersion: 2 }))
  expect(Result.isFailure(restored) && restored.failure.reason).toBe("Invalid")
  expect(Option.exists(yield* index.status(scope, lease.jobId), (pending) => Option.isNone(pending.stage))).toBe(true)
}))))
