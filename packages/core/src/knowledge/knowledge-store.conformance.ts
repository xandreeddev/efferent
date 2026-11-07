import { Effect, Option, Order, Result, Schema } from "effect"
import type { Scope } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect, sameJson } from "../conformance.functions.js"
import type { KnowledgeIndex, TemporalGraph } from "../ports/knowledge.port.js"
import { knowledgeCandidateKey } from "./knowledge.entity.functions.js"
import { KnowledgeExtraction } from "./knowledge-extraction.entity.js"
import { stageKnowledgeExtraction } from "./knowledge-extraction.entity.functions.js"
import type { Context } from "effect"
import { knowledgeScopeKey } from "./knowledge.entity.functions.js"
import {
  KnowledgeAssertionId, KnowledgeChunkId, KnowledgeEntityId, KnowledgeJobId, KnowledgeLeaseToken,
  KnowledgeMemoryId, KnowledgeSourceId,
  type KnowledgeCandidates, type KnowledgeError, type KnowledgeFailedQuery, type KnowledgeJob, type KnowledgeJobCursor, type KnowledgeJobFailure,
  type KnowledgeLease, type KnowledgeMemory, type KnowledgeScope, type KnowledgeSource, type KnowledgeSourceInfo, type KnowledgeStage,
  type KnowledgeMetadataFilter, type KnowledgeSearch, type KnowledgeStageNote,
} from "./knowledge.entity.js"

/**
 * A fresh scope per check: no two checks share owner, namespace and collection together, and the
 * index may share physical storage. Discovery (`pending`, `failed`) reads across owners, so the kit's
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
/** A stage that adds nothing but the source's restatement of `memory`: its first five characters as evidence. */
const corroborationStage = (source: KnowledgeSource, memory: KnowledgeMemory["id"], version: number): KnowledgeStage => ({
  expectedVersion: version, memories: [], chunks: [], entities: [], assertions: [], retireMemories: [], retireAssertions: [],
  corroborations: [{ memory, mention: source.ref, provenance: [{ source: source.ref, start: 0, end: 5, quote: source.text.slice(0, 5) }] }],
})
/** Claims the named job, stages what `build` makes of the current scope version and publishes it, leased at `now`. */
const publishJob = Effect.fnUntraced(function* (fixture: KnowledgeIndexFixture, job: KnowledgeJob, now: number, build: (version: number) => KnowledgeStage) {
  yield* fixture.index.claim({ scope: fixture.scope, engine: KIT_ENGINE, worker: "kit", token: KnowledgeLeaseToken.make("token"), now, leaseMs: 100, jobId: job.id })
  const lease = leaseOf(fixture.scope, job, now + 1)
  yield* fixture.index.stage(lease, build((yield* fixture.index.snapshot(fixture.scope)).version))
  yield* fixture.index.publish(lease)
})
const infoOf = (source: KnowledgeSource): KnowledgeSourceInfo => ({ ref: source.ref, occurredAt: source.occurredAt, recordedAt: source.recordedAt, metadata: source.metadata })
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
 * durable staging (its notes included), stage notes kept through restaging and publication, failure reasons, CAS atomicity, exact evidence, isolation, hybrid candidates, source and metadata filters, forgetting,
 * supersession links kept on successors (a retired memory readable by id, a link left dangling by forgetting), a memory's mentions (kept, absent on one
 * stored without them, refused outside its provenance, and its removal when a mentioned source is forgotten), a memory's event time (kept through
 * staging, publication, search and reads, and absent on one stored without it), corroborations (appended without a new record or a
 * retirement, refused when their memory is no longer active, stripped rather than retired by a later revision, and rebuilt from the surviving sources after
 * forgetting one; a narrowed read keeps a memory restated from outside it, without that evidence; a stage that supersedes a memory and
 * restates it in another record publishes), revision replacement, batched source info, engine-scoped discovery and claims, failed-job listing and requeueing
 * under another engine, and bitemporal traversal. Each check
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
      const notes = [{ _tag: "GraphOmitted" as const, reason: "Invalid" as const, message: "graph left out" }]
      yield* fixture.index.stage(lease, { ...stageOf(source), notes })
      yield* fixture.index.fail(lease, { reason: "Unavailable", message: "retryable", step: "Required" })
      const queued = yield* fixture.index.retry(fixture.scope, job.id)
      yield* claim(fixture, 30)
      const resumed = yield* fixture.index.status(fixture.scope, job.id)
      const kept = Option.exists(resumed, (value) => Option.exists(value.stage, (stage) => stage.notes?.length === 1 && stage.notes[0]?.reason === "Invalid" && stage.notes[0].message === "graph left out"))
      yield* expect("knowledge.stage-retry", queued.phase._tag === "Queued" && kept && Option.exists(resumed, (value) => value.attempt === 2), "retry discarded staged extraction, its notes or attempts")
    })),
    indexCheck("knowledge.stage-notes", (fixture) => Effect.gen(function* () {
      const source = sourceOf(fixture.scope)
      const job = yield* enqueue(fixture, source)
      yield* claim(fixture)
      const lease = leaseOf(fixture.scope, job)
      const notesOf = Effect.map(fixture.index.status(fixture.scope, job.id), (found) => Option.flatMap(found, (value) => value.stage).pipe(Option.map((stage) => stage.notes ?? [])))
      const omitted: ReadonlyArray<KnowledgeStageNote> = [{ _tag: "GraphOmitted", reason: "Unavailable", message: "graph left out" }]
      yield* fixture.index.stage(lease, { ...stageOf(source), notes: omitted })
      const graphOnly = yield* notesOf
      const dropped: ReadonlyArray<KnowledgeStageNote> = [...omitted,
        { _tag: "RecordDropped", record: "entity", key: "someone", reason: "Invalid", message: "The extraction names an unknown entity" },
        { _tag: "RecordDropped", record: "assertion", key: "relation", reason: "Invalid", message: "The extraction refers to an entity it dropped" }]
      yield* fixture.index.stage(lease, { ...stageOf(source), notes: dropped })
      const restaged = yield* notesOf
      yield* fixture.index.publish(lease)
      const published = yield* notesOf
      const complete = Option.exists(yield* fixture.index.status(fixture.scope, job.id), (value) => value.phase._tag === "Complete")
      yield* expect("knowledge.stage-notes", sameJson(graphOnly, Option.some(omitted)) && sameJson(restaged, Option.some(dropped)) && sameJson(published, Option.some(dropped)) && complete,
        "a stage's notes, a graph omission or dropped records, were lost or changed by staging, restaging or publication")
    })),
    indexCheck("knowledge.failure-reason", (fixture) => Effect.gen(function* () {
      const source = sourceOf(fixture.scope)
      const job = yield* enqueue(fixture, source)
      yield* claim(fixture)
      const graph: KnowledgeJobFailure = { reason: "Invalid", message: "the graph extraction was invalid", step: "Graph" }
      yield* fixture.index.fail(leaseOf(fixture.scope, job), graph)
      const first = yield* fixture.index.status(fixture.scope, job.id)
      yield* fixture.index.retry(fixture.scope, job.id)
      yield* claim(fixture, 30, "second-token")
      const transient: KnowledgeJobFailure = { reason: "Unavailable", message: "the embedding service was unreachable", step: "Required" }
      yield* fixture.index.fail({ ...leaseOf(fixture.scope, job, 31), token: KnowledgeLeaseToken.make("second-token") }, transient)
      const second = yield* fixture.index.status(fixture.scope, job.id)
      const failedWith = (found: Option.Option<KnowledgeJob>, failure: KnowledgeJobFailure) => Option.exists(found, (value) => sameJson(value.phase, { _tag: "Failed", ...failure }))
      yield* expect("knowledge.failure-reason", failedWith(first, graph) && failedWith(second, transient), "a failed job's status lost the reason, message or step it was failed with, or kept an earlier attempt's")
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
    indexCheck("knowledge.metadata-filter", (fixture) => Effect.gen(function* () {
      const space = { model: "kit", version: "1", dimensions: 2 }
      const near = { space, values: [1, 0] }
      const far = { space, values: [1, 8] }
      // Each source publishes a memory and a chunk; the report's are the farthest and weakest matches for "coffee".
      const publish = Effect.fnUntraced(function* (name: string, text: string, metadata: KnowledgeSource["metadata"], embedding: typeof near, step: number, extra: ReadonlyArray<KnowledgeMemory> = [], revision = 1) {
        const source = { ...sourceOf(fixture.scope, text, name, revision), metadata }
        const job = yield* enqueue(fixture, source, `${name}-job-${revision}`, revision === 1 ? Option.none() : Option.some(revision - 1))
        yield* claim(fixture, 20 + step * 10)
        const lease = leaseOf(fixture.scope, job, 21 + step * 10)
        const records = revision === 1 ? name : `${name}-${revision}`
        const memory = { ...memoryOf(source, `${records}-memory`), embedding: Option.some(embedding) }
        const chunk = { id: KnowledgeChunkId.make(`${records}-chunk`), text, provenance: memory.provenance[0]!, embedding: Option.some(embedding) }
        yield* fixture.index.stage(lease, { ...stageOf(source, step), memories: [memory, ...extra], chunks: [chunk] })
        yield* fixture.index.publish(lease)
        return source
      })
      const notes = yield* Effect.forEach([0, 1, 2], (step) => publish(`note-${step}`, "coffee coffee coffee", { kind: "note", lang: "en" }, near, step), { concurrency: 1 })
      const reportText = "A long quarterly report on travel, tea, budgets and staffing that mentions coffee once"
      const report = { ...sourceOf(fixture.scope, reportText, "report"), metadata: { kind: "report", lang: "en", pages: 3 } }
      const joint = { ...memoryOf(report, "joint-memory"), text: "The report and the first note both mention coffee", embedding: Option.some(far), provenance: [...memoryOf(report).provenance, ...memoryOf(notes[0]!).provenance] }
      yield* publish("report", reportText, report.metadata, far, 3, [joint])
      const search = (limit: number, narrowing: Pick<KnowledgeSearch, "sources" | "metadata">) => fixture.index.search({ scope: fixture.scope, query: "coffee", vector: Option.some(near), limit, knownAt: Option.none(), ...narrowing })
      const keys = (found: KnowledgeCandidates) => [found.lexical, found.semantic].map((arm) => arm.map(knowledgeCandidateKey).toSorted(Order.String).join(","))
      const target = "chunk:report-chunk,memory:report-memory"
      const everything = "chunk:note-0-chunk,chunk:note-1-chunk,chunk:note-2-chunk,chunk:report-chunk,memory:joint-memory,memory:note-0-memory,memory:note-1-memory,memory:note-2-memory,memory:report-memory"
      const results = yield* Effect.forEach([
        // The report's records rank below the three notes' six in both arms, so a filter applied after the limit finds none of them.
        [3, { metadata: { kind: "report" } }, target],
        [3, { metadata: { kind: ["memo", "report"] } }, target],
        [3, { metadata: { pages: 3, lang: "en" } }, target],
        [3, { metadata: { kind: "report", lang: "fr" } }, ""],
        [3, { metadata: { kind: [] } }, ""],
        [3, { metadata: { missing: null } }, ""],
        [3, { metadata: { kind: "report" }, sources: [notes[0]!.ref.id] }, ""],
        [3, { metadata: { kind: "report" }, sources: [report.ref.id, notes[0]!.ref.id] }, target],
        [20, { metadata: { kind: ["note", "report"] } }, everything],
        [20, { metadata: {} }, everything],
      ] as const, ([limit, narrowing, expected]) => search(limit, narrowing).pipe(Effect.map((found) => keys(found).every((arm) => arm === expected))), { concurrency: 1 })
      // A record is judged by the metadata of the revision it cites: the first revision's memory, retired by the second's
      // publication, still matches the first revision's metadata when read as of a time it was known.
      yield* publish("versioned", "coffee coffee coffee", { stage: "draft" }, near, 4)
      yield* publish("versioned", "coffee coffee coffee", { stage: "final" }, near, 5, [], 2)
      const asOf = (knownAt: Option.Option<number>, metadata: KnowledgeMetadataFilter) => fixture.index.search({ scope: fixture.scope, query: "coffee", vector: Option.some(near), limit: 3, knownAt, metadata }).pipe(Effect.map(keys))
      const revisions = [
        yield* asOf(Option.some(65), { stage: "draft" }), yield* asOf(Option.none(), { stage: "draft" }), yield* asOf(Option.none(), { stage: "final" }),
      ]
      yield* expect("knowledge.metadata-filter", results.every(Boolean) && sameJson(revisions, [
        ["memory:versioned-memory", "memory:versioned-memory"], ["", ""], ["chunk:versioned-2-chunk,memory:versioned-2-memory", "chunk:versioned-2-chunk,memory:versioned-2-memory"],
      ]), "a metadata filter dropped matching evidence ranked outside the unfiltered limit, returned evidence citing a revision that does not match, judged a record by another revision's metadata, or ignored the source filter beside it")
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
    indexCheck("knowledge.supersession-links", (fixture) => Effect.gen(function* () {
      const seeded = yield* seed(fixture)
      const later = sourceOf(fixture.scope, "Alice prefers tea now", "later")
      const job = yield* enqueue(fixture, later, "later-job")
      yield* claim(fixture, 30)
      const lease = leaseOf(fixture.scope, job, 31)
      const prior = KnowledgeMemoryId.make("memory")
      const successor: KnowledgeMemory = { ...memoryOf(later, "successor"), replaces: [{ id: prior, supersession: "change" }] }
      const alice = { id: KnowledgeEntityId.make("alice"), name: "Alice", type: "person", aliases: [], provenance: [{ source: later.ref, start: 0, end: 5, quote: "Alice" }] }
      // A relation's link may name a record this store never held: the store keeps it as written, and readers skip it.
      const relation = {
        id: KnowledgeAssertionId.make("prefers-tea"), subject: alice.id, predicate: "prefers", object: { _tag: "Value" as const, value: "tea" }, text: later.text,
        provenance: successor.provenance, validFrom: Option.none<number>(), validTo: Option.none<number>(), knownFrom: 31, knownTo: Option.none<number>(),
        replaces: [{ id: KnowledgeAssertionId.make("never-stored"), supersession: "correction" as const }],
      }
      yield* fixture.index.stage(lease, { ...stageOf(later, 1, "successor"), memories: [successor], entities: [alice], assertions: [relation], retireMemories: [prior] })
      yield* fixture.index.publish(lease)
      const linksOf = (found: Option.Option<KnowledgeMemory>) => Option.map(found, (memory) => memory.replaces)
      const read = yield* fixture.index.memory(fixture.scope, successor.id)
      const retired = yield* fixture.index.memory(fixture.scope, prior)
      const snapshot = yield* fixture.index.snapshot(fixture.scope)
      const stored = snapshot.graph.assertions.find((edge) => edge.id === relation.id)
      yield* expect("knowledge.supersession-links", sameJson(linksOf(read), Option.some(successor.replaces)) && sameJson(stored?.replaces, relation.replaces) &&
        sameJson(snapshot.memories.find((memory) => memory.id === successor.id)?.replaces, successor.replaces),
        "a successor's replaces links were lost or changed by staging, publication or reads")
      // The retired memory, stored before any link existed, reads by id unchanged but for when it was retired.
      yield* expect("knowledge.supersession-links", Option.exists(retired, (memory) => sameJson({ ...memory, knownTo: Option.none() }, seeded.stage.memories[0]) && Option.contains(memory.knownTo, 31) && !("replaces" in memory)),
        "a retired memory is no longer readable by id, gained links, or changed beyond its known end")
      // Forgetting the earlier source leaves the successor's link dangling: the successor keeps it, the earlier memory is gone.
      yield* fixture.index.forget(fixture.scope, seeded.source.ref.id, 50)
      yield* expect("knowledge.supersession-links", Option.isNone(yield* fixture.index.memory(fixture.scope, prior)) && sameJson(linksOf(yield* fixture.index.memory(fixture.scope, successor.id)), Option.some(successor.replaces)),
        "forgetting the earlier source kept its memory readable or removed the successor's link")
    })),
    indexCheck("knowledge.mentions", (fixture) => Effect.gen(function* () {
      // A memory stored without mentions, as before they existed, reads back without the key.
      const seeded = yield* seed(fixture)
      const later = sourceOf(fixture.scope, "Alice prefers coffee again", "later")
      const job = yield* enqueue(fixture, later, "later-job")
      yield* claim(fixture, 30)
      const lease = leaseOf(fixture.scope, job, 31)
      // Inferred from the earlier memory: it cites both revisions and mentions both.
      const inferred: KnowledgeMemory = {
        ...memoryOf(later, "inferred"), provenance: [...memoryOf(later).provenance, ...seeded.stage.memories[0]!.provenance],
        evidence: { _tag: "Inferred", supports: [KnowledgeMemoryId.make("memory")] }, mentions: [later.ref, seeded.source.ref],
      }
      const stray = yield* Effect.result(fixture.index.stage(lease, { ...stageOf(later, 1, "inferred"), memories: [{ ...inferred, mentions: [later.ref, { ...seeded.source.ref, revision: 2 }] }] }))
      yield* expect("knowledge.mentions", Result.isFailure(stray), "a memory that mentions a revision its provenance does not cite was staged")
      yield* fixture.index.stage(lease, { ...stageOf(later, 1, "inferred"), memories: [inferred] })
      yield* fixture.index.publish(lease)
      const read = yield* fixture.index.memory(fixture.scope, inferred.id)
      const legacy = yield* fixture.index.memory(fixture.scope, KnowledgeMemoryId.make("memory"))
      const found = yield* fixture.index.search({ scope: fixture.scope, query: "coffee", vector: Option.none(), limit: 10, knownAt: Option.none() })
      const searched = found.lexical.flatMap((candidate) => candidate._tag === "Memory" && candidate.memory.id === inferred.id ? [candidate.memory.mentions] : [])
      const snapshot = yield* fixture.index.snapshot(fixture.scope)
      yield* expect("knowledge.mentions", Option.exists(read, (memory) => sameJson(memory.mentions, inferred.mentions)) && sameJson(searched, [inferred.mentions]) &&
        sameJson(snapshot.memories.find((memory) => memory.id === inferred.id)?.mentions, inferred.mentions),
        "a memory's mentions were lost or changed by staging, publication, search or reads")
      yield* expect("knowledge.mentions", Option.exists(legacy, (memory) => !("mentions" in memory)), "a memory stored without mentions gained them")
      // Forgetting a revision it mentions removes the memory with the rest of that source's evidence.
      yield* fixture.index.forget(fixture.scope, seeded.source.ref.id, 50)
      yield* expect("knowledge.mentions", Option.isNone(yield* fixture.index.memory(fixture.scope, inferred.id)) && !(yield* fixture.index.snapshot(fixture.scope)).memories.some((memory) => memory.id === inferred.id),
        "a memory stayed readable after a revision it mentions was forgotten")
    })),
    indexCheck("knowledge.event-time", (fixture) => Effect.gen(function* () {
      // A memory stored without an event time, as before event times existed, reads back without the key.
      const seeded = yield* seed(fixture)
      const later = sourceOf(fixture.scope, "Alice books a table for Friday", "later")
      const job = yield* enqueue(fixture, later, "later-job")
      const dated: KnowledgeMemory = { ...memoryOf(later, "dated"), kind: "action", eventAt: { start: 1_000, end: 2_000 } }
      const open: KnowledgeMemory = { ...memoryOf(later, "open"), kind: "goal", eventAt: { start: 3_000 } }
      yield* publishJob(fixture, job, 30, (version) => ({ ...stageOf(later, version), memories: [dated, open] }))
      const read = yield* Effect.forEach([dated.id, open.id, seeded.stage.memories[0]!.id], (id) => fixture.index.memory(fixture.scope, id), { concurrency: 1 })
      const found = yield* fixture.index.search({ scope: fixture.scope, query: "table", vector: Option.none(), limit: 10, knownAt: Option.none() })
      const searched = found.lexical.flatMap((candidate) => candidate._tag === "Memory" ? [[candidate.memory.id, candidate.memory.eventAt]] : [])
      const snapshot = yield* fixture.index.snapshot(fixture.scope)
      const stored = (id: KnowledgeMemory["id"]) => snapshot.memories.find((memory) => memory.id === id)?.eventAt
      yield* expect("knowledge.event-time", sameJson(read.map((memory) => Option.map(memory, (value) => value.eventAt ?? null)), [Option.some(dated.eventAt), Option.some(open.eventAt), Option.some(null)]) &&
        sameJson(searched.filter(([id]) => id === dated.id || id === open.id).toSorted(([left], [right]) => Order.String(String(left), String(right))), [[dated.id, dated.eventAt], [open.id, open.eventAt]]) &&
        sameJson([stored(dated.id), stored(open.id)], [dated.eventAt, open.eventAt]),
      "a memory's event time was lost or changed by staging, publication, search or reads")
      yield* expect("knowledge.event-time", Option.exists(read[2]!, (memory) => !("eventAt" in memory)), "a memory stored without an event time gained one")
    })),
    indexCheck("knowledge.corroboration", (fixture) => Effect.gen(function* () {
      // A memory stored without mentions, restated by two other sources: one record that mentions all three.
      const seeded = yield* seed(fixture)
      const target = seeded.stage.memories[0]!
      const [second, third] = [sourceOf(fixture.scope, "Alice still prefers coffee", "second"), sourceOf(fixture.scope, "Alice keeps preferring coffee", "third")]
      const secondJob = yield* enqueue(fixture, second, "second-job")
      yield* publishJob(fixture, secondJob, 30, (version) => corroborationStage(second, target.id, version))
      const thirdJob = yield* enqueue(fixture, third, "third-job")
      yield* publishJob(fixture, thirdJob, 40, (version) => corroborationStage(third, target.id, version))
      const read = yield* fixture.index.memory(fixture.scope, target.id)
      const snapshot = yield* fixture.index.snapshot(fixture.scope)
      const found = yield* fixture.index.search({ scope: fixture.scope, query: "coffee", vector: Option.none(), limit: 10, knownAt: Option.none() })
      const mentioned = [seeded.source.ref, second.ref, third.ref]
      const evidence = [...target.provenance, ...[second, third].map((source) => ({ source: source.ref, start: 0, end: 5, quote: "Alice" }))]
      yield* expect("knowledge.corroboration", Option.exists(read, (memory) => sameJson(memory.mentions, mentioned) && sameJson(memory.provenance, evidence) && Option.isNone(memory.knownTo) && memory.knownFrom === target.knownFrom && memory.text === target.text) &&
        snapshot.memories.length === 1 && sameJson(found.lexical.flatMap((candidate) => candidate._tag === "Memory" ? [candidate.memory.mentions] : []), [mentioned]),
        "a corroboration did not append its spans and mention to the memory it restates, wrote a new record, or retired or changed the memory")
      // Forgetting a corroborating source removes the record and requeues its other sources; they rebuild it with the mentions that survive.
      yield* fixture.index.forget(fixture.scope, second.ref.id, 50)
      const requeued = yield* Effect.forEach([seeded.job, thirdJob], (job) => fixture.index.status(fixture.scope, job.id), { concurrency: 1 })
      yield* expect("knowledge.corroboration", Option.isNone(yield* fixture.index.memory(fixture.scope, target.id)) && requeued.every((job) => Option.exists(job, (value) => value.phase._tag === "Queued")),
        "forgetting a corroborating source kept the memory it restated or did not requeue the memory's other sources")
      yield* publishJob(fixture, seeded.job, 60, (version) => stageOf(seeded.source, version))
      yield* publishJob(fixture, thirdJob, 70, (version) => corroborationStage(third, target.id, version))
      yield* expect("knowledge.corroboration", Option.exists(yield* fixture.index.memory(fixture.scope, target.id), (memory) => sameJson(memory.mentions, [seeded.source.ref, third.ref]) && memory.provenance.every((span) => span.source.id !== second.ref.id)),
        "the rebuilt memory did not mention exactly the sources that survived")
    })),
    indexCheck("knowledge.corroboration-conflict", (fixture) => Effect.gen(function* () {
      // A source's later revision retires what the source published, so it cannot corroborate that: the publication is refused whole.
      const seeded = yield* seed(fixture)
      const target = seeded.stage.memories[0]!
      const revision = sourceOf(fixture.scope, "Alice prefers coffee, as before", "source", 2)
      const revisionJob = yield* enqueue(fixture, revision, "revision-job", Option.some(1))
      const own = yield* Effect.result(publishJob(fixture, revisionJob, 30, (version) => corroborationStage(revision, target.id, version)))
      const kept = yield* fixture.index.memory(fixture.scope, target.id)
      const pending = yield* fixture.index.status(fixture.scope, revisionJob.id)
      const conflict = (result: Result.Result<unknown, KnowledgeError>) => Result.isFailure(result) && result.failure.reason === "Conflict"
      yield* expect("knowledge.corroboration-conflict", conflict(own) && Option.exists(kept, (memory) => Option.isNone(memory.knownTo) && !("mentions" in memory)) && Option.exists(pending, (job) => job.phase._tag !== "Complete"),
        "a corroboration of a memory its own publication retires was published, or the refused publication changed the memory")
      // A corroboration staged while its memory was active cannot publish once another source retired it, nor stage again.
      const other = sourceOf(fixture.scope, "Alice still prefers coffee", "other")
      const otherJob = yield* enqueue(fixture, other, "other-job")
      yield* fixture.index.claim({ scope: fixture.scope, engine: KIT_ENGINE, worker: "kit", token: KnowledgeLeaseToken.make("token"), now: 40, leaseMs: 100, jobId: otherJob.id })
      const otherLease = leaseOf(fixture.scope, otherJob, 41)
      const extractedAt = (yield* fixture.index.snapshot(fixture.scope)).version
      yield* fixture.index.stage(otherLease, corroborationStage(other, target.id, extractedAt))
      const later = sourceOf(fixture.scope, "Alice prefers tea now", "later")
      const laterJob = yield* enqueue(fixture, later, "later-job")
      yield* publishJob(fixture, laterJob, 42, (version) => ({ ...stageOf(later, version, "successor"), retireMemories: [target.id] }))
      const stale = yield* Effect.result(fixture.index.publish(otherLease))
      const restaged = yield* Effect.result(fixture.index.stage(otherLease, corroborationStage(other, target.id, extractedAt + 1)))
      yield* expect("knowledge.corroboration-conflict", conflict(stale) && conflict(restaged) && Option.exists(yield* fixture.index.memory(fixture.scope, target.id), (memory) => Option.isSome(memory.knownTo) && !("mentions" in memory)),
        "a corroboration of a memory retired after extraction was published or staged")
    })),
    indexCheck("knowledge.corroboration-revision", (fixture) => Effect.gen(function* () {
      // A corroborating source's later revision takes its earlier evidence off the memory it restated instead of retiring it,
      // and retires what the source published itself, as any revision does.
      const seeded = yield* seed(fixture)
      const target = seeded.stage.memories[0]!
      const first = sourceOf(fixture.scope, "Alice still prefers coffee", "restating")
      const firstJob = yield* enqueue(fixture, first, "restating-1")
      yield* publishJob(fixture, firstJob, 30, (version) => ({ ...corroborationStage(first, target.id, version), memories: [memoryOf(first, "restating-own")] }))
      const second = sourceOf(fixture.scope, "Alice, again: coffee", "restating", 2)
      const secondJob = yield* enqueue(fixture, second, "restating-2", Option.some(1))
      yield* publishJob(fixture, secondJob, 40, (version) => corroborationStage(second, target.id, version))
      const read = yield* fixture.index.memory(fixture.scope, target.id)
      const own = yield* fixture.index.memory(fixture.scope, KnowledgeMemoryId.make("restating-own"))
      const found = yield* fixture.index.search({ scope: fixture.scope, query: "coffee", vector: Option.none(), limit: 10, knownAt: Option.none() })
      const restated = found.lexical.flatMap((candidate) => candidate._tag === "Memory" && candidate.memory.id === target.id ? [candidate.memory] : [])
      yield* expect("knowledge.corroboration-revision", Option.exists(read, (memory) => Option.isNone(memory.knownTo) && sameJson(memory.mentions, [seeded.source.ref, second.ref]) &&
        sameJson(memory.provenance, [...target.provenance, { source: second.ref, start: 0, end: 5, quote: "Alice" }])) && sameJson(restated.map((memory) => memory.mentions), [[seeded.source.ref, second.ref]]),
        "a later revision of a corroborating source retired the memory it restated, or left its earlier revision's spans or mention on it")
      yield* expect("knowledge.corroboration-revision", Option.exists(own, (memory) => Option.contains(memory.knownTo, 41)), "a later revision did not retire the memory its source published")
    })),
    indexCheck("knowledge.corroboration-reach", (fixture) => Effect.gen(function* () {
      // A restatement from outside a narrowed read neither hides the memory it restated from that read nor shows there;
      // a read that admits only the restating source finds nothing, as the memory's own evidence is outside it.
      const mine = { ...sourceOf(fixture.scope), metadata: { team: "mine" } }
      const seeded = yield* seed(fixture, mine)
      const target = seeded.stage.memories[0]!
      const other = { ...sourceOf(fixture.scope, "Alice still prefers coffee", "other"), metadata: { team: "other" } }
      yield* publishJob(fixture, yield* enqueue(fixture, other, "other-job"), 30, (version) => corroborationStage(other, target.id, version))
      const restated = (narrowing: Pick<KnowledgeSearch, "sources" | "metadata">) => fixture.index.search({ scope: fixture.scope, query: "coffee", vector: Option.none(), limit: 10, knownAt: Option.none(), ...narrowing }).pipe(
        Effect.map((found) => [...found.lexical, ...found.semantic].flatMap((candidate) => candidate._tag === "Memory" && candidate.memory.id === target.id ? [candidate.memory] : [])))
      const whole = yield* restated({})
      yield* expect("knowledge.corroboration-reach", whole.length > 0 && whole.every((memory) => sameJson(memory.mentions, [mine.ref, other.ref])),
        "a corroboration from another source did not reach the memory it restated")
      const narrowed = [...yield* restated({ sources: [mine.ref.id] }), ...yield* restated({ metadata: { team: "mine" } })]
      yield* expect("knowledge.corroboration-reach", narrowed.length > 0 && narrowed.every((memory) => sameJson(memory.mentions, [mine.ref]) && sameJson(memory.provenance, target.provenance)),
        "a read narrowed to the publishing source lost the memory once another source restated it, or showed the restating source's evidence")
      const outside = [...yield* restated({ sources: [other.ref.id] }), ...yield* restated({ metadata: { team: "other" } })]
      yield* expect("knowledge.corroboration-reach", outside.length === 0, "a read narrowed to the restating source alone found the memory another source published")
    })),
    indexCheck("knowledge.corroboration-superseded", (fixture) => Effect.gen(function* () {
      // Staging never pairs a corroboration with the retirement of its memory: an extraction that supersedes a memory in one
      // record and restates it in another stages the successor alone, and the store publishes it.
      const seeded = yield* seed(fixture)
      const target = seeded.stage.memories[0]!
      const text = "Alice prefers tea now. Alice prefers coffee."
      const source = sourceOf(fixture.scope, text, "successor")
      const job = yield* enqueue(fixture, source, "successor-job")
      const record = (key: string, start: number, end: number, change: Partial<Record<"supersedes" | "restates", ReadonlyArray<string>>>) => ({
        key, kind: target.kind, text: text.slice(start, end), entities: [], spans: [{ start, end, quote: text.slice(start, end) }], evidence: { _tag: "Stated" },
        supersedes: [], supersession: "change", ...change,
      })
      const extraction = yield* Schema.decodeUnknownEffect(KnowledgeExtraction)({ entities: [], assertions: [], memories: [
        record("tea", 0, 22, { supersedes: [target.id] }), record("coffee", 23, text.length, { restates: [target.id] }),
      ] })
      yield* fixture.index.claim({ scope: fixture.scope, engine: KIT_ENGINE, worker: "kit", token: KnowledgeLeaseToken.make("token"), now: 30, leaseMs: 100, jobId: job.id })
      const lease = leaseOf(fixture.scope, job, 31)
      yield* fixture.index.stage(lease, yield* stageKnowledgeExtraction(source, yield* fixture.index.snapshot(fixture.scope), extraction, 31))
      const published = yield* Effect.result(fixture.index.publish(lease))
      const status = yield* fixture.index.status(fixture.scope, job.id)
      const active = (yield* fixture.index.snapshot(fixture.scope)).memories.filter((memory) => Option.isNone(memory.knownTo))
      yield* expect("knowledge.corroboration-superseded", Result.isSuccess(published) && Option.exists(status, (value) => value.phase._tag === "Complete") &&
        sameJson(active.map((memory) => memory.text), ["Alice prefers tea now."]) && Option.exists(yield* fixture.index.memory(fixture.scope, target.id), (memory) => Option.isSome(memory.knownTo) && !("mentions" in memory)),
        "an extraction that supersedes a memory and restates it in another record did not publish its successor alone")
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
    indexCheck("knowledge.failed-listing", (fixture) => Effect.gen(function* () {
      const engine = scopedEngine(fixture.scope, "failed")
      const otherEngine = scopedEngine(fixture.scope, "failed-other")
      const collection = fixture.scope.collection
      const invalid: KnowledgeJobFailure = { reason: "Invalid", message: "the source was invalid", step: "Required" }
      const transient: KnowledgeJobFailure = { reason: "Unavailable", message: "the service was unreachable", step: "Required" }
      const failJob = (scope: KnowledgeScope, name: string, jobEngine: string, failure: KnowledgeJobFailure) => Effect.gen(function* () {
        const job = yield* fixture.index.enqueue({ jobId: KnowledgeJobId.make(name), source: sourceOf(scope, `Evidence of ${name}`, `${name}-source`), engine: jobEngine, expectedRevision: Option.none() })
        const token = KnowledgeLeaseToken.make(`${name}-token`)
        yield* fixture.index.claim({ scope, engine: jobEngine, worker: "kit", token, now: 20, leaseMs: 100, jobId: job.id })
        yield* fixture.index.fail({ scope, jobId: job.id, token, now: 21 }, failure)
        return job
      })
      const first = yield* failJob(fixture.scope, "failed-first", engine, invalid)
      const foreign = yield* failJob({ ...fixture.scope, collection: `${collection}-other` }, "failed-foreign", engine, transient)
      const second = yield* failJob(fixture.scope, "failed-second", engine, transient)
      const other = yield* failJob(fixture.scope, "failed-other-engine", otherEngine, transient)
      const queued = yield* enqueue(fixture, sourceOf(fixture.scope, "Queued evidence", "queued-source"), "queued-job", Option.none(), engine)
      const list = (query: Omit<KnowledgeFailedQuery, "namespace">) => fixture.index.failed({ namespace: fixture.scope.namespace, ...query })
      const ids = (jobs: ReadonlyArray<KnowledgeJob>) => jobs.map((job) => `${knowledgeScopeKey(job.scope)}/${job.id}`)
      const idOf = (job: KnowledgeJob) => ids([job])[0]
      const inCollection = yield* list({ engine, collection, limit: 100 })
      const inNamespace = yield* list({ engine, limit: 100 })
      const transientOnly = yield* list({ engine, collection, reasons: ["Unavailable"], limit: 100 })
      const noReason = yield* list({ engine, reasons: [], limit: 100 })
      const firstPage = yield* list({ engine, collection, limit: 1 })
      const secondPage = yield* Option.match(firstPage.next, { onNone: () => Effect.succeed({ jobs: [], next: Option.none() }), onSome: (after) => list({ engine, collection, limit: 1, after }) })
      // Without an engine the listing may hold other checks' jobs when storage is shared: page through all of it.
      const everyEngine = (after: Option.Option<KnowledgeJobCursor>, seen: ReadonlyArray<KnowledgeJob>, pages: number): Effect.Effect<ReadonlyArray<KnowledgeJob>, KnowledgeError> =>
        list({ collection, limit: 100, ...Option.match(after, { onNone: () => ({}), onSome: (cursor) => ({ after: cursor }) }) }).pipe(Effect.flatMap((page) => Option.isSome(page.next) && pages < 50
          ? everyEngine(page.next, [...seen, ...page.jobs], pages + 1) : Effect.succeed([...seen, ...page.jobs])))
      const unfiltered = ids(yield* everyEngine(Option.none(), [], 0))
      yield* expect("knowledge.failed-listing", sameJson(ids(inCollection.jobs), ids([first, second])) && sameJson(ids(inNamespace.jobs), ids([first, foreign, second])) && Option.isNone(inCollection.next) &&
        sameJson(ids(transientOnly.jobs), ids([second])) && noReason.jobs.length === 0 && sameJson(inCollection.jobs.map((job) => job.phase), [{ _tag: "Failed", ...invalid }, { _tag: "Failed", ...transient }]) &&
        sameJson(ids(firstPage.jobs), ids([first])) && sameJson(ids(secondPage.jobs), ids([second])) && Option.isNone(secondPage.next) &&
        [first, second, other].every((job) => unfiltered.includes(idOf(job) ?? "")) && !unfiltered.includes(idOf(queued) ?? "") && !unfiltered.includes(idOf(foreign) ?? ""),
      "the failed listing missed a failed job, listed a queued one, ignored its engine, collection or reason filters or their order, or lost a page")
    })),
    indexCheck("knowledge.requeue", (fixture) => Effect.gen(function* () {
      const older = scopedEngine(fixture.scope, "requeue-older")
      const current = scopedEngine(fixture.scope, "requeue-current")
      const source = sourceOf(fixture.scope)
      const failure: KnowledgeJobFailure = { reason: "Unavailable", message: "the service was unreachable", step: "Required" }
      const job = yield* enqueue(fixture, source, "job", Option.none(), older)
      yield* claim(fixture, 20, "token", older)
      yield* fixture.index.stage(leaseOf(fixture.scope, job), stageOf(source))
      yield* fixture.index.fail(leaseOf(fixture.scope, job), failure)
      const absent = yield* Effect.result(fixture.index.requeue({ scope: fixture.scope, jobId: KnowledgeJobId.make("absent-job"), engine: current }))
      const moved = yield* fixture.index.requeue({ scope: fixture.scope, jobId: job.id, engine: current })
      const again = yield* Effect.result(fixture.index.requeue({ scope: fixture.scope, jobId: job.id, engine: current }))
      const discover = (engine: string) => fixture.index.pending({ engine, namespace: fixture.scope.namespace, collection: fixture.scope.collection, now: 200, limit: 10 })
      const olderFound = yield* discover(older)
      const olderClaim = yield* claim(fixture, 200, "older-token", older)
      const currentFound = yield* discover(current)
      const taken = yield* claim(fixture, 200, "current-token", current)
      yield* expect("knowledge.requeue", Result.isFailure(absent) && Result.isFailure(again) && moved.phase._tag === "Queued" && moved.engine === current && moved.attempt === 0 && Option.isNone(moved.stage) &&
        olderFound.length === 0 && Option.isNone(olderClaim) && sameJson(currentFound.map((found) => found.id), [job.id]) &&
        Option.exists(taken, (value) => value.id === job.id && value.engine === current && value.attempt === 1),
      "a failed job requeued under another engine kept its attempts or the older engine's stage, stayed claimable by the older engine, was not claimable by the new one, or a job that was not failed could be requeued")
      const lease = { ...leaseOf(fixture.scope, job, 201), token: KnowledgeLeaseToken.make("current-token") }
      yield* fixture.index.stage(lease, stageOf(source))
      yield* fixture.index.fail(lease, failure)
      const reset = yield* fixture.index.requeue({ scope: fixture.scope, jobId: job.id, engine: current })
      const retaken = yield* claim(fixture, 202, "third-token", current)
      yield* expect("knowledge.requeue", reset.attempt === 0 && Option.isSome(reset.stage) && Option.exists(retaken, (value) => value.attempt === 1 && Option.isSome(value.stage)),
        "a failed job requeued under its own engine kept its attempts or lost its staged extraction")
      // Forgetting cancels a source's jobs: requeueing a failed one afterwards says the source is gone (Tombstoned), not that the job is not failed.
      const failedOf = Effect.fnUntraced(function* (source: KnowledgeSource, name: string, now: number) {
        const engine = scopedEngine(fixture.scope, name)
        const failing = yield* enqueue(fixture, source, `${name}-job`, Option.none(), engine)
        yield* claim(fixture, now, `${name}-token`, engine)
        yield* fixture.index.fail({ ...leaseOf(fixture.scope, failing, now + 1), token: KnowledgeLeaseToken.make(`${name}-token`) }, failure)
        return { job: failing, engine }
      })
      const gone = sourceOf(fixture.scope, "Alice prefers green tea", "requeue-forgotten-source")
      const forgotten = yield* failedOf(gone, "requeue-forgotten", 210)
      yield* fixture.index.forget(fixture.scope, gone.ref.id, 212)
      const tombstoned = yield* Effect.flip(fixture.index.requeue({ scope: fixture.scope, jobId: forgotten.job.id, engine: forgotten.engine }))
      // A newer revision of the source supersedes a failed job of the older one: requeueing it is a Conflict.
      const earlier = sourceOf(fixture.scope, "Alice prefers black tea", "requeue-superseded-source")
      const outdated = yield* failedOf(earlier, "requeue-superseded", 220)
      yield* enqueue(fixture, sourceOf(fixture.scope, "Alice prefers oolong", "requeue-superseded-source", 2), "requeue-superseded-newer-job", Option.some(1), outdated.engine)
      const superseded = yield* Effect.flip(fixture.index.requeue({ scope: fixture.scope, jobId: outdated.job.id, engine: outdated.engine }))
      yield* expect("knowledge.requeue", tombstoned.reason === "Tombstoned" && superseded.reason === "Conflict",
        `a failed job of a forgotten source was not refused as Tombstoned (got ${tombstoned.reason}), or one a newer revision superseded not as Conflict (got ${superseded.reason})`)
    })),
    indexCheck("knowledge.source-info", (fixture) => Effect.gen(function* () {
      const first = { ...sourceOf(fixture.scope), metadata: { kind: "note", tags: ["kit", "evidence"], origin: { system: "kit", page: 3 }, reviewed: true, score: null } }
      const second = { ...sourceOf(fixture.scope, "Bob prefers tea", "second-source"), occurredAt: 30, recordedAt: 40, metadata: { kind: "guide" } }
      yield* enqueue(fixture, first)
      yield* enqueue(fixture, second, "second-job")
      const listed = [second.ref, first.ref, first.ref, { ...first.ref, revision: 2 }, { id: KnowledgeSourceId.make("absent-source"), revision: 1 }]
      const read = yield* fixture.index.sourceInfo(fixture.scope, listed)
      const other = yield* fixture.index.sourceInfo({ ...fixture.scope, owner: `${fixture.scope.owner}-other` }, listed)
      const none = yield* fixture.index.sourceInfo(fixture.scope, [])
      yield* fixture.index.forget(fixture.scope, first.ref.id, 50)
      const forgotten = yield* fixture.index.sourceInfo(fixture.scope, listed)
      yield* expect("knowledge.source-info", sameJson(read, [infoOf(second), infoOf(first)]) && other.length === 0 && none.length === 0 && sameJson(forgotten, [infoOf(second)]),
        "source info lost a revision's times or metadata, kept a duplicate, an absent or forgotten revision, or the listed order, or crossed owner scope")
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
