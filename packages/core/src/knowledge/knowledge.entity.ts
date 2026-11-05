import { Schema } from "effect"

const Text = Schema.Trimmed.check(Schema.isNonEmpty())
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** @public */
export const KnowledgeSourceId = Text.pipe(Schema.brand("KnowledgeSourceId"))
export type KnowledgeSourceId = typeof KnowledgeSourceId.Type
/** @public */
export const KnowledgeJobId = Text.pipe(Schema.brand("KnowledgeJobId"))
export type KnowledgeJobId = typeof KnowledgeJobId.Type
/** @public */
export const KnowledgeMemoryId = Text.pipe(Schema.brand("KnowledgeMemoryId"))
export type KnowledgeMemoryId = typeof KnowledgeMemoryId.Type
/** @public */
export const KnowledgeChunkId = Text.pipe(Schema.brand("KnowledgeChunkId"))
export type KnowledgeChunkId = typeof KnowledgeChunkId.Type
/** @public */
export const KnowledgeEntityId = Text.pipe(Schema.brand("KnowledgeEntityId"))
export type KnowledgeEntityId = typeof KnowledgeEntityId.Type
/** @public */
export const KnowledgeAssertionId = Text.pipe(Schema.brand("KnowledgeAssertionId"))
export type KnowledgeAssertionId = typeof KnowledgeAssertionId.Type
/** @public */
export const KnowledgeLeaseToken = Text.pipe(Schema.brand("KnowledgeLeaseToken"))
export type KnowledgeLeaseToken = typeof KnowledgeLeaseToken.Type

/** A host-authorized isolation boundary; every read and write requires all fields. @public */
export const KnowledgeScope = Schema.Struct({ owner: Text, namespace: Text, collection: Text })
export type KnowledgeScope = typeof KnowledgeScope.Type
/** @public */
export const KnowledgeSourceRef = Schema.Struct({ id: KnowledgeSourceId, revision: Positive })
export type KnowledgeSourceRef = typeof KnowledgeSourceRef.Type
/** Original evidence. Revisions are monotonic within the scope and source. @public */
export const KnowledgeSource = Schema.Struct({
  scope: KnowledgeScope, ref: KnowledgeSourceRef, text: Schema.String,
  occurredAt: Count, recordedAt: Count, metadata: Schema.JsonObject,
})
export type KnowledgeSource = typeof KnowledgeSource.Type
/** UTF-16 offsets into the exact source revision, checked again at publication. @public */
export const KnowledgeProvenance = Schema.Struct({
  source: KnowledgeSourceRef, start: Count, end: Count, quote: Schema.String,
}).check(Schema.makeFilter((span) => span.end > span.start && span.quote.length > 0 || "provenance must cite a nonempty source span"))
export type KnowledgeProvenance = typeof KnowledgeProvenance.Type
/** Embedding identity is part of stored vectors; incompatible spaces never mix. @public */
export const KnowledgeEmbeddingSpace = Schema.Struct({ model: Text, version: Text, dimensions: Positive })
export type KnowledgeEmbeddingSpace = typeof KnowledgeEmbeddingSpace.Type
/** @public */
export const KnowledgeVector = Schema.Struct({
  space: KnowledgeEmbeddingSpace, values: Schema.Array(Schema.Number),
}).check(Schema.makeFilter((vector) => vector.values.length === vector.space.dimensions && vector.values.every(Number.isFinite) || "embedding dimension or finite-value mismatch"))
export type KnowledgeVector = typeof KnowledgeVector.Type
/** @public */
export const KnowledgeMemoryKind = Schema.Literals(["fact", "preference", "decision", "goal", "action", "routine", "profile"])
export type KnowledgeMemoryKind = typeof KnowledgeMemoryKind.Type
/** An explicit distinction between stated and inferred records. @public */
export const KnowledgeEvidence = Schema.Union([
  Schema.TaggedStruct("Stated", {}),
  Schema.TaggedStruct("Inferred", { supports: Schema.Array(KnowledgeMemoryId) }),
])
export type KnowledgeEvidence = typeof KnowledgeEvidence.Type
/** @public */
export const KnowledgeMemory = Schema.Struct({
  id: KnowledgeMemoryId, kind: KnowledgeMemoryKind, text: Text,
  provenance: Schema.Array(KnowledgeProvenance).check(Schema.isNonEmpty()),
  entities: Schema.Array(KnowledgeEntityId), evidence: KnowledgeEvidence,
  embedding: Schema.OptionFromNullOr(KnowledgeVector),
  knownFrom: Count, knownTo: Schema.OptionFromNullOr(Count),
}).check(Schema.makeFilter((memory) => memory.knownTo._tag === "None" || memory.knownTo.value >= memory.knownFrom || "known interval ends before it starts"))
export type KnowledgeMemory = typeof KnowledgeMemory.Type
/** @public */
export const KnowledgeChunk = Schema.Struct({
  id: KnowledgeChunkId, text: Schema.String, provenance: KnowledgeProvenance,
  embedding: Schema.OptionFromNullOr(KnowledgeVector),
})
export type KnowledgeChunk = typeof KnowledgeChunk.Type
/** @public */
export const KnowledgeEntity = Schema.Struct({
  id: KnowledgeEntityId, name: Text, type: Text, aliases: Schema.Array(Text),
  provenance: Schema.Array(KnowledgeProvenance).check(Schema.isNonEmpty()),
})
export type KnowledgeEntity = typeof KnowledgeEntity.Type
/** @public */
export const KnowledgeObject = Schema.Union([
  Schema.TaggedStruct("Entity", { entityId: KnowledgeEntityId }),
  Schema.TaggedStruct("Value", { value: Schema.Json }),
])
export type KnowledgeObject = typeof KnowledgeObject.Type
/** A bitemporal relation. Valid time is world time; known time is observation time. @public */
export const KnowledgeAssertion = Schema.Struct({
  id: KnowledgeAssertionId, subject: KnowledgeEntityId, predicate: Text, object: KnowledgeObject,
  text: Text, provenance: Schema.Array(KnowledgeProvenance).check(Schema.isNonEmpty()),
  validFrom: Schema.OptionFromNullOr(Count), validTo: Schema.OptionFromNullOr(Count),
  knownFrom: Count, knownTo: Schema.OptionFromNullOr(Count),
}).check(Schema.makeFilter((edge) =>
  (edge.knownTo._tag === "None" || edge.knownTo.value >= edge.knownFrom) &&
  (edge.validFrom._tag === "None" || edge.validTo._tag === "None" || edge.validTo.value >= edge.validFrom.value) || "temporal interval ends before it starts"))
export type KnowledgeAssertion = typeof KnowledgeAssertion.Type
/** Extraction is staged durably before embedding/publication. Scope CAS protects all derived writes. @public */
export const KnowledgeStage = Schema.Struct({
  expectedVersion: Count,
  memories: Schema.Array(KnowledgeMemory), chunks: Schema.Array(KnowledgeChunk),
  entities: Schema.Array(KnowledgeEntity), assertions: Schema.Array(KnowledgeAssertion),
  retireMemories: Schema.Array(KnowledgeMemoryId), retireAssertions: Schema.Array(KnowledgeAssertionId),
})
export type KnowledgeStage = typeof KnowledgeStage.Type
/** @public */
export const KnowledgeJobPhase = Schema.Union([
  Schema.TaggedStruct("Queued", {}),
  Schema.TaggedStruct("Processing", { token: KnowledgeLeaseToken, worker: Text, leaseUntil: Count }),
  Schema.TaggedStruct("Failed", { message: Schema.String }),
  Schema.TaggedStruct("Complete", { publishedAt: Count }),
  Schema.TaggedStruct("Cancelled", { cancelledAt: Count }),
])
export type KnowledgeJobPhase = typeof KnowledgeJobPhase.Type
/**
 * A processing job. `engine` names the processor and the embedding space it indexes with
 * (`knowledgeEngineId`); only workers of that engine discover or claim it. @public
 */
export const KnowledgeJob = Schema.Struct({
  id: KnowledgeJobId, scope: KnowledgeScope, source: KnowledgeSourceRef, engine: Text,
  attempt: Count, phase: KnowledgeJobPhase, stage: Schema.OptionFromNullOr(KnowledgeStage),
})
export type KnowledgeJob = typeof KnowledgeJob.Type
/** @public */
export const KnowledgeEnqueue = Schema.Struct({
  jobId: KnowledgeJobId, source: KnowledgeSource, engine: Text,
  expectedRevision: Schema.OptionFromNullOr(Positive),
})
export type KnowledgeEnqueue = typeof KnowledgeEnqueue.Type
/**
 * A worker's lease request in one scope. Only a job recorded under `engine` is claimable, with or
 * without `jobId`, so engines that share a collection never take each other's work. @public
 */
export const KnowledgeClaim = Schema.Struct({
  scope: KnowledgeScope, engine: Text, worker: Text, token: KnowledgeLeaseToken, now: Count,
  leaseMs: Positive, jobId: Schema.optionalKey(KnowledgeJobId),
})
export type KnowledgeClaim = typeof KnowledgeClaim.Type
/** Host worker discovery across owners within one engine and namespace (and collection, when given). @public */
export const KnowledgePending = Schema.Struct({ engine: Text, namespace: Text, collection: Schema.optionalKey(Text), now: Count, limit: Positive.check(Schema.isLessThanOrEqualTo(100)) })
export type KnowledgePending = typeof KnowledgePending.Type
/** @public */
export const KnowledgeLease = Schema.Struct({ scope: KnowledgeScope, jobId: KnowledgeJobId, token: KnowledgeLeaseToken, now: Count })
export type KnowledgeLease = typeof KnowledgeLease.Type
/** Both coordinates are exclusive upper bounds on relation intervals. @public */
export const KnowledgePerspective = Schema.Struct({ validAt: Count, knownAt: Count })
export type KnowledgePerspective = typeof KnowledgePerspective.Type
/** Candidate stores return independent ranked arms; the engine fuses them. @public */
export const KnowledgeCandidate = Schema.Union([
  Schema.TaggedStruct("Memory", { memory: KnowledgeMemory, score: Schema.Number }),
  Schema.TaggedStruct("Chunk", { chunk: KnowledgeChunk, score: Schema.Number }),
])
export type KnowledgeCandidate = typeof KnowledgeCandidate.Type
/** @public */
export const KnowledgeSearch = Schema.Struct({
  scope: KnowledgeScope, query: Schema.String, vector: Schema.OptionFromNullOr(KnowledgeVector),
  limit: Positive.check(Schema.isLessThanOrEqualTo(100)),
  knownAt: Schema.OptionFromNullOr(Count),
})
export type KnowledgeSearch = typeof KnowledgeSearch.Type
/** @public */
export const KnowledgeCandidates = Schema.Struct({ lexical: Schema.Array(KnowledgeCandidate), semantic: Schema.Array(KnowledgeCandidate) })
export type KnowledgeCandidates = typeof KnowledgeCandidates.Type
/** @public */
export const KnowledgeTraversal = Schema.Struct({
  scope: KnowledgeScope, seeds: Schema.Array(KnowledgeEntityId), perspective: KnowledgePerspective,
  depth: Positive.check(Schema.isLessThanOrEqualTo(3)), limit: Positive.check(Schema.isLessThanOrEqualTo(100)),
})
export type KnowledgeTraversal = typeof KnowledgeTraversal.Type
/** @public */
export const KnowledgeSubgraph = Schema.Struct({ entities: Schema.Array(KnowledgeEntity), assertions: Schema.Array(KnowledgeAssertion), truncated: Schema.Boolean })
export type KnowledgeSubgraph = typeof KnowledgeSubgraph.Type
/** @public */
export const KnowledgeSnapshot = Schema.Struct({ version: Count, memories: Schema.Array(KnowledgeMemory), graph: KnowledgeSubgraph })
export type KnowledgeSnapshot = typeof KnowledgeSnapshot.Type
/** @public */
export const KnowledgeRecall = Schema.Struct({
  scope: KnowledgeScope, query: Schema.String, limit: Positive.check(Schema.isLessThanOrEqualTo(100)),
  maxChars: Positive, graph: Schema.optionalKey(Schema.Union([Schema.Literal(false), Schema.Struct({ perspective: Schema.Struct({ validAt: Schema.optionalKey(Count), knownAt: Schema.optionalKey(Count) }), depth: Positive.check(Schema.isLessThanOrEqualTo(3)) })])),
})
export type KnowledgeRecall = typeof KnowledgeRecall.Type
/** @public */
export const KnowledgeRecallResult = Schema.Struct({ candidates: Schema.Array(KnowledgeCandidate), graph: KnowledgeSubgraph })
export type KnowledgeRecallResult = typeof KnowledgeRecallResult.Type
/** What a knowledge engine asks of a `UtilityLlm` helper call: extract a source part, review that extraction, plan a search or rerank its evidence. @public */
export const KnowledgeHelperPurpose = Schema.Literals(["extract", "review", "plan", "rerank"])
export type KnowledgeHelperPurpose = typeof KnowledgeHelperPurpose.Type
/** The processing job a helper call works for, at the attempt that claimed it (1 for the first claim). @public */
export const KnowledgeHelperJob = Schema.Struct({ id: KnowledgeJobId, attempt: Count })
export type KnowledgeHelperJob = typeof KnowledgeHelperJob.Type
/**
 * What one helper call is for, set by a knowledge engine around each
 * `UtilityLlm.complete` it makes (`CurrentKnowledgeHelperCall`): the purpose,
 * the scope it reads and writes, the job for extraction and review (none for
 * a search's planning and reranking), and the output cap the engine was
 * configured with, if any. A `UtilityLlm` adapter can read it to budget,
 * attribute or refuse a call; the output cap is advisory, applied only by an
 * adapter that reads it (the models plugin's `UtilityLlmLive` does not).
 * @public
 */
export const KnowledgeHelperCall = Schema.Struct({
  purpose: KnowledgeHelperPurpose, scope: KnowledgeScope,
  job: Schema.OptionFromNullOr(KnowledgeHelperJob),
  maxOutputTokens: Schema.OptionFromNullOr(Positive),
})
export type KnowledgeHelperCall = typeof KnowledgeHelperCall.Type
/** @public */
export const KnowledgeErrorReason = Schema.Literals(["Conflict", "LeaseLost", "Tombstoned", "Invalid", "Unavailable", "Corrupt", "EmbeddingMismatch"])
export type KnowledgeErrorReason = typeof KnowledgeErrorReason.Type
/** Expected storage/extraction errors preserve the original cause. @public */
export class KnowledgeError extends Schema.TaggedError<KnowledgeError>()("KnowledgeError", {
  reason: KnowledgeErrorReason, message: Schema.String, cause: Schema.optionalKey(Schema.Defect()),
}) {}
