import { Effect, Option, Order, Result } from "effect"
import type { Scope } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect } from "../conformance.functions.js"
import type { KnowledgeIndex, TemporalGraph } from "../ports/knowledge.port.js"
import { knowledgeCandidateKey } from "./knowledge.entity.functions.js"
import type { Context } from "effect"
import { knowledgeScopeKey } from "./knowledge.entity.functions.js"
import {
  KnowledgeAssertionId, KnowledgeChunkId, KnowledgeEntityId, KnowledgeJobId, KnowledgeLeaseToken,
  KnowledgeMemoryId, KnowledgeSourceId,
  type KnowledgeCandidates, type KnowledgeJob, type KnowledgeLease, type KnowledgeMemory, type KnowledgeScope,
  type KnowledgeSource, type KnowledgeStage,
} from "./knowledge.entity.js"

/**
 * A fresh scope per check: no two checks share owner, namespace and collection together, and the
 * index may share physical storage. Discovery (`pending`) reads across owners, so the kit's
 * discovery checks record their jobs under engine ids derived from the whole scope, which no other
 * check uses. @public
 */
export interface KnowledgeIndexFixture {
  readonly index: KnowledgeIndex
  readonly scope: KnowledgeScope
  /** Optional separate graph view over the same index, tested after the kit seeds it. */
  readonly graph?: Context.Service.Shape<typeof TemporalGraph>
}
/** Opens a fresh isolated fixture and releases its resources with the scope. @public */
export interface KnowledgeIndexSubject { readonly open: Effect.Effect<KnowledgeIndexFixture, unknown, Scope.Scope> }

const sourceOf = (scope: KnowledgeScope, text = "Alice prefers coffee", name = "source", revision = 1): KnowledgeSource => ({
  scope, ref: { id: KnowledgeSourceId.make(name), revision }, text, occurredAt: 10, recordedAt: 20, metadata: {},
})
const KIT_ENGINE = "kit"
const enqueue = (fixture: KnowledgeIndexFixture, source: KnowledgeSource, name = "job", previous: Option.Option<number> = Option.none(), engine = KIT_ENGINE) => fixture.index.enqueue({ jobId: KnowledgeJobId.make(name), source, engine, expectedRevision: previous })
const leaseOf = (scope: KnowledgeScope, job: KnowledgeJob, now = 21): KnowledgeLease => ({ scope, jobId: job.id, token: KnowledgeLeaseToken.make("token"), now })
const claim = (fixture: KnowledgeIndexFixture, now = 20, token = "token", engine = KIT_ENGINE) => fixture.index.claim({ scope: fixture.scope, engine, worker: "kit", token: KnowledgeLeaseToken.make(token), now, leaseMs: 100 })
/** An engine id no other check (and no other fixture) records jobs under, so cross-owner discovery sees only this check's jobs. */
const scopedEngine = (scope: KnowledgeScope, name: string) => `${KIT_ENGINE}-${name}:${knowledgeScopeKey(scope)}`
const memoryOf = (source: KnowledgeSource, name = "memory"): KnowledgeMemory => ({
  id: KnowledgeMemoryId.make(name), kind: "preference", text: source.text,
  provenance: [{ source: source.ref, start: 0, end: source.text.length, quote: source.text }],
  entities: [], evidence: { _tag: "Stated" }, embedding: Option.some({ space: { model: "kit", version: "1", dimensions: 2 }, values: [1, 0] }), knownFrom: 21, knownTo: Option.none(),
})
const stageOf = (source: KnowledgeSource, version = 0, name = "memory"): KnowledgeStage => ({
  expectedVersion: version, memories: [memoryOf(source, name)], chunks: [], entities: [], assertions: [], retireMemories: [], retireAssertions: [],
})
const seed = Effect.fnUntraced(function* (fixture: KnowledgeIndexFixture, source: KnowledgeSource = sourceOf(fixture.scope)) {
  const job = yield* enqueue(fixture, source)
  yield* claim(fixture)
  const lease = leaseOf(fixture.scope, job)
  const stage = stageOf(source)
  yield* fixture.index.stage(lease, stage)
  yield* fixture.index.publish(lease)
  return { source, job, lease, stage }
})

/**
 * Shared memory/document-store guarantees: replay and immutable revisions, lease fencing,
 * durable staging, CAS atomicity, exact evidence, isolation, hybrid candidates, source filters, forgetting,
 * revision replacement, engine-scoped discovery and claims, and bitemporal traversal. Each check
 * opens a fresh fixture.
 * @public
 */
export const knowledgeStoreConformance = (subject: KnowledgeIndexSubject): ReadonlyArray<ConformanceCheck> => {
  const indexCheck = (id: string, body: (fixture: KnowledgeIndexFixture) => Effect.Effect<void, unknown>): ConformanceCheck =>
    check(id, id, () => Effect.scoped(Effect.flatMap(subject.open, body)))
  return [
    indexCheck("knowledge.source-replay", (fixture) => Effect.gen(function* () {
      const source = sourceOf(fixture.scope)
      const job = yield* enqueue(fixture, source)
      const replay = yield* enqueue(fixture, source, "other-job")
      const conflict = yield* Effect.result(enqueue(fixture, { ...source, text: "different" }))
      const read = yield* fixture.index.source(fixture.scope, source.ref)
      yield* expect("knowledge.source-replay", replay.id === job.id && Result.isFailure(conflict) && Option.exists(read, (value) => value.text === source.text), "source replay lost identity or conflicting content changed evidence")
    })),
    indexCheck("knowledge.lease-fencing", (fixture) => Effect.gen(function* () {
      const source = sourceOf(fixture.scope)
      const job = yield* enqueue(fixture, source)
      const claims = yield* Effect.all([claim(fixture), claim(fixture, 20, "competitor")], { concurrency: 2 })
      yield* expect("knowledge.lease-fencing", claims.filter(Option.isSome).length === 1, "two workers claimed one live job")
      const taken = yield* claim(fixture, 121, "new-token")
      const stale = yield* Effect.result(fixture.index.stage(leaseOf(fixture.scope, job, 122), stageOf(source)))
      yield* expect("knowledge.lease-fencing", Option.exists(taken, (value) => value.attempt === 2) && Result.isFailure(stale), "expired worker retained write authority")
    })),
    indexCheck("knowledge.stage-retry", (fixture) => Effect.gen(function* () {
      const source = sourceOf(fixture.scope)
      const job = yield* enqueue(fixture, source)
      yield* claim(fixture)
      const lease = leaseOf(fixture.scope, job)
      yield* fixture.index.stage(lease, stageOf(source))
      yield* fixture.index.fail(lease, "retryable")
      const queued = yield* fixture.index.retry(fixture.scope, job.id)
      yield* claim(fixture, 30)
      const resumed = yield* fixture.index.status(fixture.scope, job.id)
      yield* expect("knowledge.stage-retry", queued.phase._tag === "Queued" && Option.exists(resumed, (value) => Option.isSome(value.stage) && value.attempt === 2), "retry discarded staged extraction or attempts")
    })),
    indexCheck("knowledge.atomic-cas", (fixture) => Effect.gen(function* () {
      yield* seed(fixture)
      const source = sourceOf(fixture.scope, "Bob prefers tea", "second")
      const job = yield* enqueue(fixture, source, "second-job")
      yield* claim(fixture)
      const lease = leaseOf(fixture.scope, job)
      const failed = yield* Effect.result(fixture.index.stage(lease, stageOf(source, 0, "second-memory")).pipe(Effect.andThen(fixture.index.publish(lease))))
      const snapshot = yield* fixture.index.snapshot(fixture.scope)
      const status = yield* fixture.index.status(fixture.scope, job.id)
      yield* expect("knowledge.atomic-cas", Result.isFailure(failed) && snapshot.version === 1 && snapshot.memories.length === 1 && Option.exists(status, (value) => value.phase._tag === "Processing"), "a stale publication partially committed")
    })),
    indexCheck("knowledge.exact-provenance", (fixture) => Effect.gen(function* () {
      const source = sourceOf(fixture.scope)
      const job = yield* enqueue(fixture, source)
      yield* claim(fixture)
      const lease = leaseOf(fixture.scope, job)
      const memory = memoryOf(source)
      const failed = yield* Effect.result(fixture.index.stage(lease, { ...stageOf(source), memories: [{ ...memory, provenance: memory.provenance.map((span) => ({ ...span, quote: "invented" })) }] }).pipe(Effect.andThen(fixture.index.publish(lease))))
      const snapshot = yield* fixture.index.snapshot(fixture.scope)
      yield* expect("knowledge.exact-provenance", Result.isFailure(failed) && snapshot.version === 0 && snapshot.memories.length === 0, "invented quotations reached the index")
      const invalidInterval = yield* Effect.result(fixture.index.stage(lease, { ...stageOf(source), memories: [{ ...memory, knownFrom: 10, knownTo: Option.some(9) }] }).pipe(Effect.andThen(fixture.index.publish(lease))))
      const afterInterval = yield* fixture.index.snapshot(fixture.scope)
      yield* expect("knowledge.exact-provenance", Result.isFailure(invalidInterval) && afterInterval.version === 0, "an invalid temporal interval partially published")
    })),
    indexCheck("knowledge.scope-isolation", (fixture) => Effect.gen(function* () {
      const seeded = yield* seed(fixture)
      const other = { ...fixture.scope, owner: `${fixture.scope.owner}-other` }
      const own = yield* fixture.index.search({ scope: fixture.scope, query: "coffee", vector: Option.none(), limit: 10, knownAt: Option.none() })
      const missing = yield* fixture.index.source(other, seeded.source.ref)
      const absent = yield* fixture.index.memory(other, KnowledgeMemoryId.make("memory"))
      const foreign = yield* fixture.index.search({ scope: other, query: "coffee", vector: Option.none(), limit: 10, knownAt: Option.none() })
      yield* expect("knowledge.scope-isolation", own.lexical.length === 1 && Option.isNone(missing) && Option.isNone(absent) && foreign.lexical.length === 0, "one owner's source, memory or candidates crossed scope")
    })),
    indexCheck("knowledge.hybrid-candidates", (fixture) => Effect.gen(function* () {
      yield* seed(fixture)
      const query = { scope: fixture.scope, query: "coffee", vector: Option.some({ space: { model: "kit", version: "1", dimensions: 2 }, values: [1, 0] }), limit: 10, knownAt: Option.none<number>() }
      const found = yield* fixture.index.search(query)
      const mismatch = yield* Effect.result(fixture.index.search({ ...query, vector: Option.some({ space: { model: "other", version: "1", dimensions: 2 }, values: [1, 0] }) }))
      yield* expect("knowledge.hybrid-candidates", found.lexical.length === 1 && found.semantic.length === 1 && Result.isFailure(mismatch), "candidate arms or embedding-space isolation failed")
    })),
    indexCheck("knowledge.source-filter", (fixture) => Effect.gen(function* () {
      const vector = { space: { model: "kit", version: "1", dimensions: 2 }, values: [1, 0] }
      const chunkOf = (source: KnowledgeSource, name: string) => ({ id: KnowledgeChunkId.make(name), text: source.text, provenance: memoryOf(source).provenance[0]!, embedding: Option.some(vector) })
      const first = sourceOf(fixture.scope)
      const firstJob = yield* enqueue(fixture, first)
      yield* claim(fixture)
      yield* fixture.index.stage(leaseOf(fixture.scope, firstJob), { ...stageOf(first), chunks: [chunkOf(first, "first-chunk")] })
      yield* fixture.index.publish(leaseOf(fixture.scope, firstJob))
      const second = sourceOf(fixture.scope, "Bob prefers coffee", "second")
      const secondJob = yield* enqueue(fixture, second, "second-job")
      yield* claim(fixture, 30)
      const joint = { ...memoryOf(second, "joint-memory"), text: "Alice and Bob prefer coffee", provenance: [...memoryOf(first).provenance, ...memoryOf(second).provenance] }
      yield* fixture.index.stage(leaseOf(fixture.scope, secondJob, 31), { ...stageOf(second, 1, "second-memory"), memories: [memoryOf(second, "second-memory"), joint], chunks: [chunkOf(second, "second-chunk")] })
      yield* fixture.index.publish(leaseOf(fixture.scope, secondJob, 31))
      const search = (sources?: ReadonlyArray<KnowledgeSourceId>) => fixture.index.search({ scope: fixture.scope, query: "coffee", vector: Option.some(vector), limit: 10, knownAt: Option.none(), ...(sources === undefined ? {} : { sources }) })
      const keys = (found: KnowledgeCandidates) => [found.lexical, found.semantic].map((arm) => arm.map(knowledgeCandidateKey).toSorted(Order.String).join(","))
      const firstOnly = keys(yield* search([first.ref.id]))
      const both = keys(yield* search([first.ref.id, second.ref.id]))
      const none = keys(yield* search([]))
      const all = keys(yield* search())
      const everything = "chunk:first-chunk,chunk:second-chunk,memory:joint-memory,memory:memory,memory:second-memory"
      yield* expect("knowledge.source-filter", firstOnly.every((arm) => arm === "chunk:first-chunk,memory:memory") && both.every((arm) => arm === everything) && none.every((arm) => arm === "") && all.every((arm) => arm === everything),
        "a source filter returned evidence citing an unlisted source, dropped a listed one, or an empty filter returned anything")
    })),
    indexCheck("knowledge.forget-tombstone", (fixture) => Effect.gen(function* () {
      const seeded = yield* seed(fixture)
      yield* fixture.index.forget(fixture.scope, seeded.source.ref.id, 50)
      yield* fixture.index.forget(fixture.scope, seeded.source.ref.id, 51)
      const replay = yield* Effect.result(enqueue(fixture, seeded.source))
      const source = yield* fixture.index.source(fixture.scope, seeded.source.ref)
      const memory = yield* fixture.index.memory(fixture.scope, KnowledgeMemoryId.make("memory"))
      const snapshot = yield* fixture.index.snapshot(fixture.scope)
      yield* expect("knowledge.forget-tombstone", Result.isFailure(replay) && Option.isNone(source) && Option.isNone(memory) && snapshot.memories.length === 0, "forgotten evidence remained visible or was resurrected")
    })),
    indexCheck("knowledge.source-revision", (fixture) => Effect.gen(function* () {
      const seeded = yield* seed(fixture)
      const source = sourceOf(fixture.scope, "Alice prefers tea", "source", 2)
      const job = yield* enqueue(fixture, source, "revision-job", Option.some(1))
      yield* claim(fixture)
      const lease = leaseOf(fixture.scope, job, 40)
      yield* fixture.index.stage(lease, stageOf(source, 1, "new-memory"))
      yield* fixture.index.publish(lease)
      const old = yield* fixture.index.source(fixture.scope, seeded.source.ref)
      const retired = yield* fixture.index.memory(fixture.scope, KnowledgeMemoryId.make("memory"))
      const search = yield* fixture.index.search({ scope: fixture.scope, query: "coffee tea", vector: Option.none(), limit: 10, knownAt: Option.none() })
      const snapshot = yield* fixture.index.snapshot(fixture.scope)
      yield* expect("knowledge.source-revision", Option.isSome(old) && Option.exists(retired, (memory) => Option.contains(memory.knownTo, 40)) && snapshot.memories.length === 2 && search.lexical.length === 1 && search.lexical[0]?._tag === "Memory" && search.lexical[0].memory.id === "new-memory", "replacement lost explicit historical record reads or kept stale current memory")
      yield* fixture.index.forget(fixture.scope, source.ref.id, 50)
      yield* expect("knowledge.source-revision", Option.isNone(yield* fixture.index.memory(fixture.scope, KnowledgeMemoryId.make("memory"))) && Option.isNone(yield* fixture.index.memory(fixture.scope, KnowledgeMemoryId.make("new-memory"))), "forget retained old or current immutable record reads")
    })),
    indexCheck("knowledge.immutable-chunk-identity", (fixture) => Effect.gen(function* () {
      const first = sourceOf(fixture.scope)
      const job = yield* enqueue(fixture, first)
      yield* claim(fixture)
      const chunk = { id: KnowledgeChunkId.make("fixed-chunk"), text: first.text, provenance: memoryOf(first).provenance[0]!, embedding: Option.none() }
      yield* fixture.index.stage(leaseOf(fixture.scope, job), { ...stageOf(first), chunks: [chunk] })
      yield* fixture.index.publish(leaseOf(fixture.scope, job))
      const revision = sourceOf(fixture.scope, "Replacement text", "source", 2)
      const replacement = yield* enqueue(fixture, revision, "replacement", Option.some(1))
      yield* claim(fixture)
      yield* fixture.index.stage(leaseOf(fixture.scope, replacement), stageOf(revision, 1, "replacement-memory"))
      yield* fixture.index.publish(leaseOf(fixture.scope, replacement))
      const other = sourceOf(fixture.scope, first.text, "other")
      const reused = yield* enqueue(fixture, other, "reuse")
      yield* claim(fixture)
      yield* fixture.index.stage(leaseOf(fixture.scope, reused), { ...stageOf(other, 2, "other-memory"), chunks: [{ ...chunk, provenance: memoryOf(other).provenance[0]! }] })
      const refused = yield* Effect.result(fixture.index.publish(leaseOf(fixture.scope, reused)))
      yield* expect("knowledge.immutable-chunk-identity", Result.isFailure(refused) && Option.isNone(yield* fixture.index.chunk(fixture.scope, chunk.id)), "an obsolete citation identity was rebound to another source")
    })),
    indexCheck("knowledge.entity-forget-rebuild", (fixture) => Effect.gen(function* () {
      const first = sourceOf(fixture.scope)
      const entity = { id: KnowledgeEntityId.make("shared-person"), name: "Alice", type: "person", aliases: ["private-alias"], provenance: memoryOf(first).provenance }
      const job = yield* enqueue(fixture, first)
      yield* claim(fixture)
      yield* fixture.index.stage(leaseOf(fixture.scope, job), { ...stageOf(first), entities: [entity], memories: [{ ...memoryOf(first), entities: [entity.id] }] })
      yield* fixture.index.publish(leaseOf(fixture.scope, job))
      const other = sourceOf(fixture.scope, "Alice starts early", "other")
      const second = yield* enqueue(fixture, other, "other-job")
      yield* claim(fixture)
      const unaffected = memoryOf(other, "other-unrelated-memory")
      const chunk = { id: KnowledgeChunkId.make("other-chunk"), text: other.text, provenance: unaffected.provenance[0]!, embedding: Option.none() }
      yield* fixture.index.stage(leaseOf(fixture.scope, second), { ...stageOf(other, 1, "other-memory"), memories: [{ ...memoryOf(other, "other-memory"), entities: [entity.id] }, unaffected], chunks: [chunk] })
      yield* fixture.index.publish(leaseOf(fixture.scope, second))
      const dependentSource = sourceOf(fixture.scope, "Carol observed an early start", "dependent")
      const dependentJob = yield* enqueue(fixture, dependentSource, "dependent-job")
      yield* claim(fixture)
      const dependent = { ...memoryOf(dependentSource, "dependent-memory"), evidence: { _tag: "Inferred" as const, supports: [unaffected.id] }, provenance: [...memoryOf(dependentSource).provenance, ...unaffected.provenance] }
      const unrelatedDependent = memoryOf(dependentSource, "dependent-unrelated-memory")
      yield* fixture.index.stage(leaseOf(fixture.scope, dependentJob), { ...stageOf(dependentSource, 2), memories: [dependent, unrelatedDependent] })
      yield* fixture.index.publish(leaseOf(fixture.scope, dependentJob))
      yield* fixture.index.forget(fixture.scope, first.ref.id, 50)
      const snapshot = yield* fixture.index.snapshot(fixture.scope)
      const rebuild = yield* fixture.index.status(fixture.scope, second.id)
      const dependentRebuild = yield* fixture.index.status(fixture.scope, dependentJob.id)
      yield* expect("knowledge.entity-forget-rebuild", snapshot.graph.entities.length === 0 && snapshot.memories.length === 0 && Option.isNone(yield* fixture.index.chunk(fixture.scope, chunk.id)) && Option.exists(rebuild, (value) => value.phase._tag === "Queued" && Option.isNone(value.stage)) && Option.exists(dependentRebuild, (value) => value.phase._tag === "Queued" && Option.isNone(value.stage)), "deleted entity attribution survived, source outputs were only partly invalidated, or transitive surviving evidence was not requeued")
      const claimed = yield* claim(fixture, 60)
      yield* expect("knowledge.entity-forget-rebuild", Option.exists(claimed, (value) => value.id === second.id), "the surviving evidence job could not be reclaimed")
      yield* fixture.index.stage(leaseOf(fixture.scope, second, 61), { ...stageOf(other, snapshot.version, "other-memory"), memories: [memoryOf(other, "other-memory"), unaffected], chunks: [chunk] })
      yield* fixture.index.publish(leaseOf(fixture.scope, second, 61))
      yield* expect("knowledge.entity-forget-rebuild", Option.isSome(yield* fixture.index.memory(fixture.scope, KnowledgeMemoryId.make("other-memory"))) && Option.isSome(yield* fixture.index.memory(fixture.scope, unaffected.id)) && Option.isSome(yield* fixture.index.chunk(fixture.scope, chunk.id)), "same-source rebuild was rejected or unrelated evidence did not return after conservative invalidation")
      yield* claim(fixture, 62)
      yield* fixture.index.stage(leaseOf(fixture.scope, dependentJob, 63), { ...stageOf(dependentSource, snapshot.version + 1), memories: [dependent, unrelatedDependent] })
      yield* fixture.index.publish(leaseOf(fixture.scope, dependentJob, 63))
      yield* expect("knowledge.entity-forget-rebuild", Option.isSome(yield* fixture.index.memory(fixture.scope, dependent.id)) && Option.isSome(yield* fixture.index.memory(fixture.scope, unrelatedDependent.id)), "transitive source rebuild could not republish its immutable identities")
    })),
    indexCheck("knowledge.forgotten-stage-privacy", (fixture) => Effect.gen(function* () {
      const first = sourceOf(fixture.scope)
      const entity = { id: KnowledgeEntityId.make("private-person"), name: "Alice", type: "person", aliases: [], provenance: memoryOf(first).provenance }
      const initial = yield* enqueue(fixture, first)
      yield* claim(fixture)
      yield* fixture.index.stage(leaseOf(fixture.scope, initial), { ...stageOf(first), entities: [entity] })
      yield* fixture.index.publish(leaseOf(fixture.scope, initial))
      const other = sourceOf(fixture.scope, "A surviving conversation", "survivor")
      const oldJob = yield* enqueue(fixture, other, "survivor-old")
      yield* claim(fixture)
      yield* fixture.index.stage(leaseOf(fixture.scope, oldJob), { ...stageOf(other, 1, "survivor-old-memory"), memories: [{ ...memoryOf(other, "survivor-old-memory"), entities: [entity.id], provenance: [...memoryOf(other).provenance, ...entity.provenance] }] })
      yield* fixture.index.publish(leaseOf(fixture.scope, oldJob))
      const replacement = sourceOf(fixture.scope, "A revised surviving conversation", "survivor", 2)
      const newJob = yield* enqueue(fixture, replacement, "survivor-new", Option.some(1))
      yield* claim(fixture)
      yield* fixture.index.stage(leaseOf(fixture.scope, newJob), stageOf(replacement, 2, "survivor-new-memory"))
      yield* fixture.index.publish(leaseOf(fixture.scope, newJob))
      yield* fixture.index.forget(fixture.scope, first.ref.id, 50)
      const old = yield* fixture.index.status(fixture.scope, oldJob.id)
      const current = yield* fixture.index.status(fixture.scope, newJob.id)
      yield* expect("knowledge.forgotten-stage-privacy", Option.exists(old, (job) => job.phase._tag === "Complete" && Option.isNone(job.stage)) && Option.exists(current, (job) => job.phase._tag === "Queued" && Option.isNone(job.stage)), "an older completed job retained staged deleted evidence or the latest surviving revision was not requeued")
    })),
    indexCheck("knowledge.unpublished-stage-privacy", (fixture) => Effect.gen(function* () {
      const initial = yield* seed(fixture)
      const source = sourceOf(fixture.scope, "A surviving conversation", "survivor")
      const job = yield* enqueue(fixture, source, "survivor-job")
      yield* claim(fixture)
      const lease = leaseOf(fixture.scope, job, 51)
      const staged = { ...stageOf(source, 1, "survivor-memory"), memories: [{ ...memoryOf(source, "survivor-memory"), evidence: { _tag: "Inferred" as const, supports: [KnowledgeMemoryId.make("memory")] }, provenance: [...memoryOf(source).provenance, ...memoryOf(initial.source).provenance] }] }
      yield* fixture.index.stage(leaseOf(fixture.scope, job), staged)
      const otherScope = { ...fixture.scope, owner: `${fixture.scope.owner}-other` }
      const otherSource = sourceOf(otherScope, "Other owner evidence", "survivor")
      const otherJob = yield* fixture.index.enqueue({ jobId: KnowledgeJobId.make("other-owner-job"), source: otherSource, engine: KIT_ENGINE, expectedRevision: Option.none() })
      yield* fixture.index.claim({ scope: otherScope, engine: KIT_ENGINE, worker: "kit", token: KnowledgeLeaseToken.make("token"), now: 20, leaseMs: 100 })
      yield* fixture.index.stage(leaseOf(otherScope, otherJob), stageOf(otherSource, 0, "other-owner-memory"))
      yield* fixture.index.forget(fixture.scope, initial.source.ref.id, 50)
      const status = yield* fixture.index.status(fixture.scope, job.id)
      const otherStatus = yield* fixture.index.status(otherScope, otherJob.id)
      yield* expect("knowledge.unpublished-stage-privacy", Option.exists(status, (current) => current.phase._tag === "Processing" && Option.isNone(current.stage)) && Option.exists(otherStatus, (current) => current.phase._tag === "Processing" && Option.isSome(current.stage)) && Option.isSome(yield* fixture.index.source(fixture.scope, source.ref)), "forget retained an unpublished extraction, changed an unrelated lease, or crossed owner scope")
      const clearedPublish = yield* Effect.result(fixture.index.publish(lease))
      const unpublished = yield* fixture.index.snapshot(fixture.scope)
      yield* expect("knowledge.unpublished-stage-privacy", Result.isFailure(clearedPublish) && clearedPublish.failure.reason === "Conflict" && unpublished.version === 2 && unpublished.memories.length === 0 && unpublished.graph.assertions.length === 0, "publishing a cleared stage was not retryable or partially changed the index")
      const stale = yield* Effect.result(fixture.index.stage(lease, staged))
      const version = (yield* fixture.index.snapshot(fixture.scope)).version
      const forgotten = yield* Effect.result(fixture.index.stage(lease, { ...staged, expectedVersion: version }))
      const after = yield* fixture.index.status(fixture.scope, job.id)
      yield* expect("knowledge.unpublished-stage-privacy", Result.isFailure(stale) && stale.failure.reason === "Conflict" && Result.isFailure(forgotten) && Option.exists(after, (current) => Option.isNone(current.stage)), "an in-flight worker restored stale or forgotten source evidence into durable staging")
      yield* fixture.index.stage(lease, stageOf(source, version, "survivor-memory"))
      yield* fixture.index.publish(lease)
      yield* expect("knowledge.unpublished-stage-privacy", Option.isSome(yield* fixture.index.memory(fixture.scope, KnowledgeMemoryId.make("survivor-memory"))), "a cleared unpublished extraction could not be rebuilt from its surviving source")
    })),
    indexCheck("knowledge.pending-discovery", (fixture) => Effect.gen(function* () {
      const engine = scopedEngine(fixture.scope, "discovery")
      const foreign = { ...sourceOf(fixture.scope, "Other collection", "foreign-source"), scope: { ...fixture.scope, collection: `${fixture.scope.collection}-other` } }
      yield* fixture.index.enqueue({ jobId: KnowledgeJobId.make("foreign-job"), source: foreign, engine, expectedRevision: Option.none() })
      const source = sourceOf(fixture.scope)
      const job = yield* enqueue(fixture, source, "job", Option.none(), engine)
      yield* claim(fixture, 20, "token", engine)
      const live = yield* fixture.index.pending({ engine, namespace: fixture.scope.namespace, collection: fixture.scope.collection, now: 21, limit: 1 })
      const expired = yield* fixture.index.pending({ engine, namespace: fixture.scope.namespace, collection: fixture.scope.collection, now: 121, limit: 1 })
      const other = yield* fixture.index.pending({ engine: `${engine}-different`, namespace: fixture.scope.namespace, collection: fixture.scope.collection, now: 121, limit: 1 })
      yield* expect("knowledge.pending-discovery", live.length === 0 && expired.length === 1 && expired[0]?.id === job.id && other.length === 0, "durable discovery lost expired work, filtered collection after its limit, or crossed engine boundaries")
    })),
    indexCheck("knowledge.engine-isolation", (fixture) => Effect.gen(function* () {
      const first = scopedEngine(fixture.scope, "first")
      const second = scopedEngine(fixture.scope, "second")
      const firstJob = yield* enqueue(fixture, sourceOf(fixture.scope, "First engine evidence", "first-source"), "first-job", Option.none(), first)
      const secondJob = yield* enqueue(fixture, sourceOf(fixture.scope, "Second engine evidence", "second-source"), "second-job", Option.none(), second)
      const discover = (engine: string) => fixture.index.pending({ engine, namespace: fixture.scope.namespace, collection: fixture.scope.collection, now: 20, limit: 10 })
      const firstFound = yield* discover(first)
      const secondFound = yield* discover(second)
      yield* expect("knowledge.engine-isolation", firstFound.length === 1 && firstFound[0]?.id === firstJob.id && secondFound.length === 1 && secondFound[0]?.id === secondJob.id, "discovery returned another engine's job in the same collection")
      const requested = yield* fixture.index.claim({ scope: fixture.scope, engine: second, worker: "kit", token: KnowledgeLeaseToken.make("requested"), now: 20, leaseMs: 100, jobId: firstJob.id })
      const taken = yield* claim(fixture, 20, "first-token", first)
      const exhausted = yield* claim(fixture, 20, "first-again", first)
      const own = yield* claim(fixture, 20, "second-token", second)
      yield* expect("knowledge.engine-isolation", Option.isNone(requested) && Option.exists(taken, (job) => job.id === firstJob.id && job.engine === first) && Option.isNone(exhausted) && Option.exists(own, (job) => job.id === secondJob.id && job.engine === second), "a worker claimed a job recorded under another engine")
    })),
    indexCheck("knowledge.bitemporal-change", (fixture) => Effect.gen(function* () {
      const first = sourceOf(fixture.scope, "Alice works at Acme", "employment-one")
      const ids = [KnowledgeEntityId.make("alice"), KnowledgeEntityId.make("acme"), KnowledgeEntityId.make("globex")]
      const original = { id: KnowledgeAssertionId.make("original"), subject: ids[0]!, predicate: "works_at", object: { _tag: "Entity" as const, entityId: ids[1]! }, text: first.text, provenance: memoryOf(first).provenance, validFrom: Option.some(10), validTo: Option.none<number>(), knownFrom: 1, knownTo: Option.none<number>() }
      const initial = yield* enqueue(fixture, first)
      yield* claim(fixture)
      yield* fixture.index.stage(leaseOf(fixture.scope, initial), { ...stageOf(first), entities: ids.map((id) => ({ id, name: id, type: "thing", aliases: [], provenance: original.provenance })), assertions: [original] })
      yield* fixture.index.publish(leaseOf(fixture.scope, initial))
      const second = sourceOf(fixture.scope, "Alice joined Globex on day 50", "employment-two")
      const changed = yield* enqueue(fixture, second, "changed")
      yield* claim(fixture)
      const provenance = [...original.provenance, ...memoryOf(second).provenance]
      const historical = { ...original, id: KnowledgeAssertionId.make("revised-history"), validTo: Option.some(50), provenance }
      const replacement = { ...original, id: KnowledgeAssertionId.make("replacement"), object: { _tag: "Entity" as const, entityId: ids[2]! }, validFrom: Option.some(50), text: second.text, provenance: memoryOf(second).provenance }
      yield* fixture.index.stage(leaseOf(fixture.scope, changed, 40), { ...stageOf(second, 1, "changed-memory"), assertions: [historical, replacement], retireAssertions: [original.id] })
      yield* fixture.index.publish(leaseOf(fixture.scope, changed, 40))
      const query = { scope: fixture.scope, seeds: [ids[0]!], perspective: { validAt: 60, knownAt: 30 }, depth: 1, limit: 10 }
      const graph = fixture.graph ?? fixture.index
      const earlierKnowledge = yield* graph.traverse(query)
      const historicalTruth = yield* graph.traverse({ ...query, perspective: { validAt: 40, knownAt: 41 } })
      const currentTruth = yield* graph.traverse({ ...query, perspective: { validAt: 60, knownAt: 41 } })
      const snapshot = yield* fixture.index.snapshot(fixture.scope)
      yield* expect("knowledge.bitemporal-change", earlierKnowledge.assertions.length === 1 && earlierKnowledge.assertions[0]?.id === original.id && historicalTruth.assertions.length === 1 && historicalTruth.assertions[0]?.id === historical.id && currentTruth.assertions.length === 1 && currentTruth.assertions[0]?.id === replacement.id && snapshot.graph.assertions.some((edge) => edge.id === historical.id && edge.knownFrom === 40), "change collapsed world history or assigned knowledge before publication")
    })),
    indexCheck("knowledge.bitemporal-traversal", (fixture) => Effect.gen(function* () {
      const source = sourceOf(fixture.scope)
      const job = yield* enqueue(fixture, source)
      yield* claim(fixture)
      const lease = leaseOf(fixture.scope, job)
      const ids = [KnowledgeEntityId.make("alice"), KnowledgeEntityId.make("team"), KnowledgeEntityId.make("office")]
      const provenance = memoryOf(source).provenance
      const edge = (index: number, from: number, until: Option.Option<number>) => ({ id: KnowledgeAssertionId.make(`edge-${index}`), subject: ids[index]!, predicate: "located", object: { _tag: "Entity" as const, entityId: ids[index + 1]! }, text: source.text, provenance, validFrom: Option.some(from), validTo: until, knownFrom: 21, knownTo: Option.none<number>() })
      yield* fixture.index.stage(lease, { ...stageOf(source), entities: ids.map((id) => ({ id, name: id, type: "thing", aliases: [], provenance })), assertions: [edge(0, 10, Option.none()), edge(1, 50, Option.none())] })
      yield* fixture.index.publish(lease)
      const graph = fixture.graph ?? fixture.index
      const before = yield* graph.traverse({ scope: fixture.scope, seeds: [ids[0]!], perspective: { validAt: 40, knownAt: 30 }, depth: 2, limit: 10 })
      const after = yield* graph.traverse({ scope: fixture.scope, seeds: [ids[0]!], perspective: { validAt: 60, knownAt: 30 }, depth: 2, limit: 10 })
      const unknown = yield* graph.traverse({ scope: fixture.scope, seeds: [ids[0]!], perspective: { validAt: 60, knownAt: 20 }, depth: 2, limit: 10 })
      const bounded = yield* graph.traverse({ scope: fixture.scope, seeds: [ids[0]!], perspective: { validAt: 60, knownAt: 30 }, depth: 2, limit: 1 })
      yield* expect("knowledge.bitemporal-traversal", before.assertions.length === 1 && after.assertions.length === 2 && unknown.assertions.length === 0 && bounded.truncated && bounded.assertions.length <= 1 && bounded.entities.length <= 1, "traversal ignored time, depth or bounds")
    })),
  ]
}

/** Memory stores satisfy the same durable processing contract as RAG stores. @public */
export const memoryStoreConformance = knowledgeStoreConformance

/** TemporalGraph's bitemporal and bounded traversal contract, seeded through its backing index. @public */
export const temporalGraphConformance = (subject: KnowledgeIndexSubject): ReadonlyArray<ConformanceCheck> =>
  knowledgeStoreConformance(subject).filter((check) => check.name.startsWith("knowledge.bitemporal-"))
