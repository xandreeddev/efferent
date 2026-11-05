import { Effect, Match, Option, Result } from "effect"
import type { Context, Scope } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect, sameJson } from "../conformance.functions.js"
import type { Knowledge, LongTermMemory } from "../ports/knowledge.port.js"
import { KnowledgeJobId, KnowledgeSourceId } from "./knowledge.entity.js"
import type { KnowledgeRecallResult, KnowledgeScope } from "./knowledge.entity.js"
import { citedKnowledgeSources } from "./knowledge.entity.functions.js"

/** Fresh native memory service, with workers disabled and valid scripted extraction. @public */
export interface LongTermMemorySubject {
  readonly open: Effect.Effect<{ readonly memory: Context.Service.Shape<typeof LongTermMemory>; readonly scope: KnowledgeScope }, unknown, Scope.Scope>
}
type KnowledgeFixture = { readonly knowledge: Context.Service.Shape<typeof Knowledge>; readonly scope: KnowledgeScope }
/** Fresh document service, with workers disabled and valid scripted extraction if enabled. @public */
export interface KnowledgeSubject {
  readonly open: Effect.Effect<KnowledgeFixture, unknown, Scope.Scope>
  /**
   * A fresh service like `open` whose optional graph extraction fails on every attempt (an
   * unavailable helper or an invalid answer). Without it, `failed-extraction` runs on `open`
   * and shows only that plain retrieval completes.
   */
  readonly failingExtraction?: Effect.Effect<KnowledgeFixture, unknown, Scope.Scope>
}
type Memory = Context.Service.Shape<typeof LongTermMemory>
type Facade = Omit<Memory, "capture" | "profile"> & { readonly accept: Memory["capture"]; readonly profile?: Memory["profile"] }
interface Fixture { readonly facade: Facade; readonly scope: KnowledgeScope }

const sourceOf = (scope: KnowledgeScope) => ({
  scope, ref: { id: KnowledgeSourceId.make("facade-source"), revision: 1 },
  text: "I prefer tea.", occurredAt: 10, recordedAt: 20, metadata: {},
})
const accept = (fixture: Fixture, id = "facade-job") => fixture.facade.accept({
  jobId: KnowledgeJobId.make(id), source: sourceOf(fixture.scope), engine: "facade-kit", expectedRevision: Option.none(),
})
const seed = Effect.fnUntraced(function* (fixture: Fixture, id: string) {
  const job = yield* accept(fixture)
  const processed = yield* fixture.facade.process(fixture.scope, 1)
  const status = yield* fixture.facade.status(fixture.scope, job.id)
  yield* expect(id, processed === 1 && Option.exists(status, (value) => value.phase._tag === "Complete"), "explicit processing did not complete an accepted source")
  return job
})

const facadeConformance = (prefix: string, open: Effect.Effect<Fixture, unknown, Scope.Scope>): ReadonlyArray<ConformanceCheck> => {
  const test = (name: string, body: (fixture: Fixture, id: string) => Effect.Effect<void, unknown>) => {
    const id = `${prefix}.${name}`
    return check(id, id, () => Effect.scoped(Effect.flatMap(open, (fixture) => body(fixture, id))))
  }
  return [
    test("accepted-source", (fixture, id) => Effect.gen(function* () {
      const job = yield* accept(fixture)
      const status = yield* fixture.facade.status(fixture.scope, job.id)
      const source = yield* fixture.facade.source(fixture.scope, job.source)
      const absent = yield* fixture.facade.status(fixture.scope, KnowledgeJobId.make("absent"))
      const invalidRetry = yield* Effect.result(fixture.facade.retry(fixture.scope, job.id))
      yield* expect(id, job.phase._tag === "Queued" && Option.exists(status, (value) => value.phase._tag === "Queued") && Option.exists(source, (value) => value.text === sourceOf(fixture.scope).text) && Option.isNone(absent) && Result.isFailure(invalidRetry), "acceptance was not durable, absence was not explicit, or an unfailed job could be retried")
    })),
    test("processing", (fixture, id) => Effect.gen(function* () {
      const job = yield* seed(fixture, id)
      yield* expect(id, (yield* fixture.facade.process(fixture.scope, 1)) === 0 && Option.isSome(yield* fixture.facade.source(fixture.scope, job.source)), "completed processing ran again or discarded original evidence")
    })),
    test("source-replay", (fixture, id) => Effect.gen(function* () {
      const initial = yield* accept(fixture)
      const replay = yield* accept(fixture, "another-job")
      const conflict = yield* Effect.result(fixture.facade.accept({ jobId: KnowledgeJobId.make("conflict"), source: { ...sourceOf(fixture.scope), text: "Different evidence" }, engine: "facade-kit", expectedRevision: Option.none() }))
      const source = yield* fixture.facade.source(fixture.scope, initial.source)
      yield* expect(id, replay.id === initial.id && Result.isFailure(conflict) && Option.exists(source, (value) => value.text === sourceOf(fixture.scope).text), "replay changed job identity or conflicting source content replaced evidence")
    })),
    test("owner-isolation", (fixture, id) => Effect.gen(function* () {
      const job = yield* seed(fixture, id)
      const other = { ...fixture.scope, owner: `${fixture.scope.owner}-other` }
      const source = yield* fixture.facade.source(other, job.source)
      const status = yield* fixture.facade.status(other, job.id)
      const recalled = yield* fixture.facade.recall({ scope: other, query: "tea", limit: 10, maxChars: 1000, graph: false })
      const profile = fixture.facade.profile === undefined ? [] : yield* fixture.facade.profile(other)
      yield* expect(id, Option.isNone(source) && Option.isNone(status) && recalled.candidates.length === 0 && recalled.graph.assertions.length === 0 && recalled.graph.entities.length === 0 && profile.length === 0, "an owner's sources, processing status, memories or graph crossed scope")
    })),
    test("forget-tombstone", (fixture, id) => Effect.gen(function* () {
      const job = yield* seed(fixture, id)
      yield* fixture.facade.forget(fixture.scope, job.source.id)
      const source = yield* fixture.facade.source(fixture.scope, job.source)
      const replay = yield* Effect.result(accept(fixture))
      const recalled = yield* fixture.facade.recall({ scope: fixture.scope, query: "tea", limit: 10, maxChars: 1000 })
      const status = yield* fixture.facade.status(fixture.scope, job.id)
      yield* expect(id, Option.isNone(source) && Result.isFailure(replay) && recalled.candidates.length === 0 && recalled.graph.assertions.length === 0 && Option.exists(status, (value) => value.phase._tag === "Cancelled" && Option.isNone(value.stage)), "forgotten source evidence survived or replay resurrected it")
    })),
    test("source-filter", (fixture, id) => Effect.gen(function* () {
      const first = yield* seed(fixture, id)
      const other = { ...sourceOf(fixture.scope), ref: { id: KnowledgeSourceId.make("facade-other"), revision: 1 } }
      yield* fixture.facade.accept({ jobId: KnowledgeJobId.make("facade-other-job"), source: other, engine: "facade-kit", expectedRevision: Option.none() })
      yield* expect(id, (yield* fixture.facade.process(fixture.scope, 1)) === 1, "explicit processing did not complete a second accepted source")
      const recall = (sources?: ReadonlyArray<KnowledgeSourceId>) => fixture.facade.recall({ scope: fixture.scope, query: "tea", limit: 10, maxChars: 1000, ...(sources === undefined ? {} : { sources }) })
      const cited = (result: KnowledgeRecallResult): ReadonlyArray<string> => [
        ...result.candidates.flatMap((candidate) => Match.valueTags(candidate, { Memory: ({ memory }) => memory.provenance, Chunk: ({ chunk }) => [chunk.provenance] })),
        ...result.graph.assertions.flatMap((edge) => edge.provenance), ...result.graph.entities.flatMap((entity) => entity.provenance),
      ].map((span) => span.source.id)
      const narrowed = cited(yield* recall([first.source.id]))
      const empty = yield* recall([])
      const whole = cited(yield* recall())
      yield* expect(id, narrowed.length > 0 && narrowed.every((source) => source === first.source.id) && whole.includes(first.source.id) && whole.includes(other.ref.id) &&
        empty.candidates.length === 0 && empty.graph.assertions.length === 0 && empty.graph.entities.length === 0,
      "recall narrowed to one source returned another's evidence or none of its own, an empty filter returned evidence, or an unfiltered recall missed a source")
    })),
    test("cited-sources", (fixture, id) => Effect.gen(function* () {
      const source = { ...sourceOf(fixture.scope), metadata: { kind: "note", tags: ["kit"], origin: { page: 3 } } }
      yield* fixture.facade.accept({ jobId: KnowledgeJobId.make("facade-job"), source, engine: "facade-kit", expectedRevision: Option.none() })
      const processed = yield* fixture.facade.process(fixture.scope, 1)
      const result = yield* fixture.facade.recall({ scope: fixture.scope, query: "tea", limit: 10, maxChars: 1000 })
      const info = { ref: source.ref, occurredAt: source.occurredAt, recordedAt: source.recordedAt, metadata: source.metadata }
      yield* expect(id, processed === 1 && result.candidates.length > 0 && sameJson(citedKnowledgeSources(result), [source.ref]) && sameJson(result.sources, [info]),
        "recalled evidence did not carry the times and metadata of exactly the source revisions it cites")
    })),
    test("retrieval-bounds", (fixture, id) => Effect.gen(function* () {
      yield* seed(fixture, id)
      const result = yield* fixture.facade.recall({ scope: fixture.scope, query: "tea", limit: 1, maxChars: 1, graph: false })
      const size = result.candidates.reduce((sum, candidate) => sum + Match.valueTags(candidate, { Memory: ({ memory }) => memory.text.length, Chunk: ({ chunk }) => chunk.text.length }), 0) + result.graph.assertions.reduce((sum, edge) => sum + edge.text.length, 0)
      yield* expect(id, size <= 1 && result.candidates.length <= 1 && result.graph.assertions.length === 0 && result.graph.entities.length === 0, "explicit graph:false or the combined evidence budget was ignored")
    })),
  ]
}

/** Async processing, isolation, source retention, deletion, cited source info and retrieval contracts; no model-quality assertions. @public */
export const longTermMemoryConformance = (subject: LongTermMemorySubject): ReadonlyArray<ConformanceCheck> => facadeConformance("long_term_memory", Effect.map(subject.open, ({ memory, scope }) => ({ scope, facade: { ...memory, accept: memory.capture } })))
const failedExtraction = (subject: KnowledgeSubject): ConformanceCheck => {
  const id = "knowledge_facade.failed-extraction"
  return check(id, id, () => Effect.scoped(Effect.gen(function* () {
    const { knowledge, scope } = yield* (subject.failingExtraction ?? subject.open)
    const source = sourceOf(scope)
    const job = yield* knowledge.ingest({ jobId: KnowledgeJobId.make("facade-job"), source, engine: "facade-kit", expectedRevision: Option.none() })
    const processed = yield* knowledge.process(scope, 1)
    const status = yield* knowledge.status(scope, job.id)
    const recalled = yield* knowledge.retrieve({ scope, query: "tea", limit: 10, maxChars: 1000, graph: false })
    const cited = recalled.candidates.some((candidate) => Match.valueTags(candidate, { Memory: () => false, Chunk: ({ chunk }) => chunk.provenance.source.id === source.ref.id && chunk.provenance.source.revision === source.ref.revision }))
    yield* expect(id, processed === 1 && Option.exists(status, (value) => value.phase._tag === "Complete") && cited, "a failed optional extraction kept the source's chunks from publication or plain retrieval")
    if (subject.failingExtraction !== undefined) yield* expect(id, Option.exists(Option.flatMap(status, (value) => value.stage), (stage) => (stage.notes ?? []).some((note) => note._tag === "GraphOmitted")), "the completed job did not record that its graph was omitted")
  })))
}

/**
 * Async document processing, isolation, source retention, deletion, cited source info and retrieval contracts;
 * a failed optional graph extraction still publishes the source's chunks.
 * @public
 */
export const knowledgeConformance = (subject: KnowledgeSubject): ReadonlyArray<ConformanceCheck> => [
  ...facadeConformance("knowledge_facade", Effect.map(subject.open, ({ knowledge, scope }) => ({ scope, facade: { ...knowledge, accept: knowledge.ingest, recall: knowledge.retrieve } }))),
  failedExtraction(subject),
]
