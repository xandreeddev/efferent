import { Effect, Schema } from "effect"

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
/** A source revision's identity, times and host metadata, without its text or scope. @public */
export const KnowledgeSourceInfo = Schema.Struct({ ref: KnowledgeSourceRef, occurredAt: Count, recordedAt: Count, metadata: Schema.JsonObject })
export type KnowledgeSourceInfo = typeof KnowledgeSourceInfo.Type
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
/**
 * Why a record took the place of an earlier one: the world `change`d (the earlier record held
 * until then), or the earlier record was wrong and this is its `correction`.
 * @public
 */
export const KnowledgeSupersession = Schema.Literals(["change", "correction"])
export type KnowledgeSupersession = typeof KnowledgeSupersession.Type
/** A successor memory's link to a memory it superseded, which publication retired. @public */
export const KnowledgeMemoryReplacement = Schema.Struct({ id: KnowledgeMemoryId, supersession: KnowledgeSupersession })
export type KnowledgeMemoryReplacement = typeof KnowledgeMemoryReplacement.Type
/**
 * A successor relation's link to the earlier state it replaced: for a `change`, the history copy
 * that holds the earlier relation with its validity ended; for a `correction`, the retired relation.
 * @public
 */
export const KnowledgeAssertionReplacement = Schema.Struct({ id: KnowledgeAssertionId, supersession: KnowledgeSupersession })
export type KnowledgeAssertionReplacement = typeof KnowledgeAssertionReplacement.Type
/**
 * When the event a memory concerns takes place, in world time: `start`, and `end` for an event that
 * lasts beyond its start (a trip's return), never before `start`. Epoch milliseconds.
 * @public
 */
export const KnowledgeEventTime = Schema.Struct({ start: Count, end: Schema.optionalKey(Count) })
  .check(Schema.makeFilter((event) => event.end === undefined || event.end >= event.start || "event ends before it starts"))
export type KnowledgeEventTime = typeof KnowledgeEventTime.Type
/**
 * A durable memory. `replaces` links a successor to the memories it superseded; staging writes it
 * on the successor only when there is one, and nothing is ever written to the memory it retired
 * but its `knownTo`. A memory without it, as every one stored before it existed, replaces none.
 * `mentions` are the source revisions whose own text states the record, a subset of the revisions
 * its provenance cites: staging writes the revision it extracts a stated memory from, and for an
 * inferred memory that revision and every revision that states one of its supports. Its provenance
 * may cite more revisions, for the evidence of its entities, which never count as stating it. A
 * memory stored before `mentions` existed reads them from its provenance (`knowledgeMemoryMentions`).
 * The first mention is the revision that published the memory; publication appends each revision
 * that restates it later (`KnowledgeCorroboration`), and a later revision of such a source takes
 * its earlier revision's mention and spans away again without retiring the memory.
 * `eventAt` is the time of the dated event the memory concerns (`KnowledgeEventTime`), written only
 * when the extraction gives one; a memory without it, as every one stored before it existed, concerns
 * no dated event. A goal, decision, action or preference whose event has passed is past
 * (`knowledgeMemoryIsPast`): recall demotes and labels it, the profile leaves it out, and it is
 * never deleted for it.
 * @public
 */
export const KnowledgeMemory = Schema.Struct({
  id: KnowledgeMemoryId, kind: KnowledgeMemoryKind, text: Text,
  provenance: Schema.Array(KnowledgeProvenance).check(Schema.isNonEmpty()),
  entities: Schema.Array(KnowledgeEntityId), evidence: KnowledgeEvidence,
  embedding: Schema.OptionFromNullOr(KnowledgeVector),
  knownFrom: Count, knownTo: Schema.OptionFromNullOr(Count),
  replaces: Schema.optionalKey(Schema.Array(KnowledgeMemoryReplacement)),
  mentions: Schema.optionalKey(Schema.Array(KnowledgeSourceRef)),
  eventAt: Schema.optionalKey(KnowledgeEventTime),
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
/**
 * A bitemporal relation. Valid time is world time; known time is observation time.
 * `validFromBasis` says where `validFrom` came from: `stated` by the source, or `observed`, the
 * source's occurrence time, for a change the source states as present without a date (it held
 * by then at the latest). Staging writes it with every `validFrom`; an assertion without it, as
 * every one stored before it existed, reads as stated. `replaces` links a successor to the earlier
 * states it replaced (`KnowledgeAssertionReplacement`), written on the successor only when there is
 * one; an assertion without it replaces none.
 * @public
 */
export const KnowledgeAssertion = Schema.Struct({
  id: KnowledgeAssertionId, subject: KnowledgeEntityId, predicate: Text, object: KnowledgeObject,
  text: Text, provenance: Schema.Array(KnowledgeProvenance).check(Schema.isNonEmpty()),
  validFrom: Schema.OptionFromNullOr(Count), validTo: Schema.OptionFromNullOr(Count),
  validFromBasis: Schema.optionalKey(Schema.Literals(["stated", "observed"])),
  knownFrom: Count, knownTo: Schema.OptionFromNullOr(Count),
  replaces: Schema.optionalKey(Schema.Array(KnowledgeAssertionReplacement)),
}).check(Schema.makeFilter((edge) =>
  (edge.knownTo._tag === "None" || edge.knownTo.value >= edge.knownFrom) &&
  (edge.validFrom._tag === "None" || edge.validTo._tag === "None" || edge.validTo.value >= edge.validFrom.value) || "temporal interval ends before it starts"))
export type KnowledgeAssertion = typeof KnowledgeAssertion.Type
/** @public */
export const KnowledgeErrorReason = Schema.Literals(["Conflict", "LeaseLost", "Tombstoned", "Invalid", "Unavailable", "Corrupt", "EmbeddingMismatch"])
export type KnowledgeErrorReason = typeof KnowledgeErrorReason.Type
/**
 * A derivation an engine left out of a stage, and why. `GraphOmitted`: optional graph extraction
 * failed on the job's last attempt, so the source's chunks publish without entities or assertions.
 * `RecordDropped`: staging left out one extracted record (`record`, by the extraction's local
 * `key`) that failed a check of its own (an invalid span, an unknown identity, an undefined or
 * dropped entity key, an unknown or inactive record it supersedes, restates or cites as support, an
 * unsupported inferred routine, an inverted validity interval), and the rest of the extraction
 * was staged. A stage stored before `RecordDropped` existed holds only `GraphOmitted` notes and
 * decodes unchanged.
 * @public
 */
export const KnowledgeStageNote = Schema.Union([
  Schema.TaggedStruct("GraphOmitted", { reason: KnowledgeErrorReason, message: Schema.String }),
  Schema.TaggedStruct("RecordDropped", {
    record: Schema.Literals(["entity", "memory", "assertion"]), key: Schema.String, reason: KnowledgeErrorReason, message: Schema.String,
  }),
])
export type KnowledgeStageNote = typeof KnowledgeStageNote.Type
/**
 * The source revision being published states an active stated memory again, without changing it:
 * publication appends `provenance`, the revision's own spans (each citing `mention`), to the memory's
 * provenance and `mention` to its `mentions`, so the memory counts one more mention and forgetting
 * the revision removes it through the source closure. Nothing is written as a new record and the
 * memory is not retired. A memory published by `mention`'s own source is never a target: publishing
 * a later revision of a source retires what that source published.
 * @public
 */
export const KnowledgeCorroboration = Schema.Struct({
  memory: KnowledgeMemoryId, mention: KnowledgeSourceRef,
  provenance: Schema.Array(KnowledgeProvenance).check(Schema.isNonEmpty()),
})
export type KnowledgeCorroboration = typeof KnowledgeCorroboration.Type
/**
 * Extraction is staged durably before embedding/publication. Scope CAS protects all derived writes.
 * `notes` is written only when a derivation or a record was left out, and stays on the job after publication.
 * `corroborations` is written only when the source restates active memories (`KnowledgeCorroboration`);
 * a stage stored before it existed corroborates none.
 * @public
 */
export const KnowledgeStage = Schema.Struct({
  expectedVersion: Count,
  memories: Schema.Array(KnowledgeMemory), chunks: Schema.Array(KnowledgeChunk),
  entities: Schema.Array(KnowledgeEntity), assertions: Schema.Array(KnowledgeAssertion),
  retireMemories: Schema.Array(KnowledgeMemoryId), retireAssertions: Schema.Array(KnowledgeAssertionId),
  notes: Schema.optionalKey(Schema.Array(KnowledgeStageNote)),
  corroborations: Schema.optionalKey(Schema.Array(KnowledgeCorroboration)),
})
export type KnowledgeStage = typeof KnowledgeStage.Type
/**
 * The step of a job's processing that failed. `Graph`: the optional graph extraction, which an
 * engine leaves out on the job's last attempt (`GraphOmitted`). `Required`: anything the job cannot
 * publish without (reading its source, the extraction it needs, embedding, storage).
 * @public
 */
export const KnowledgeFailureStep = Schema.Literals(["Required", "Graph"])
export type KnowledgeFailureStep = typeof KnowledgeFailureStep.Type
/**
 * Why a processing attempt failed, as `KnowledgeIndex.fail` records it on the job's `Failed` phase:
 * the `KnowledgeError` reason, its message and the step that failed (`isRetryableKnowledgeFailure`
 * tells whether retrying can help). A job failed before reasons were recorded decodes with reason
 * `Unavailable` at step `Required`, so it counts as retryable and its next failure records its own reason.
 * @public
 */
export const KnowledgeJobFailure = Schema.Struct({
  reason: KnowledgeErrorReason.pipe(Schema.withDecodingDefaultKey(Effect.succeed("Unavailable" as const))),
  message: Schema.String,
  step: KnowledgeFailureStep.pipe(Schema.withDecodingDefaultKey(Effect.succeed("Required" as const))),
})
export type KnowledgeJobFailure = typeof KnowledgeJobFailure.Type
/** @public */
export const KnowledgeJobPhase = Schema.Union([
  Schema.TaggedStruct("Queued", {}),
  Schema.TaggedStruct("Processing", { token: KnowledgeLeaseToken, worker: Text, leaseUntil: Count }),
  Schema.TaggedStruct("Failed", KnowledgeJobFailure.fields),
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
/** Where a failed-job listing stopped: opaque, read only by the store that returned it. @public */
export const KnowledgeJobCursor = Text.pipe(Schema.brand("KnowledgeJobCursor"))
export type KnowledgeJobCursor = typeof KnowledgeJobCursor.Type
/**
 * Host discovery of failed jobs across owners within one namespace: of every engine, or of
 * `engine` when given; of one collection when given; failed with one of `reasons` when given (an
 * empty list matches none). Oldest job first, at most `limit`, after `after` (a page's `next`).
 * @public
 */
export const KnowledgeFailedQuery = Schema.Struct({
  engine: Schema.optionalKey(Text), namespace: Text, collection: Schema.optionalKey(Text),
  reasons: Schema.optionalKey(Schema.Array(KnowledgeErrorReason)),
  limit: Positive.check(Schema.isLessThanOrEqualTo(100)),
  after: Schema.optionalKey(KnowledgeJobCursor),
})
export type KnowledgeFailedQuery = typeof KnowledgeFailedQuery.Type
/** One page of failed jobs, and the cursor of the next page while more jobs match. @public */
export const KnowledgeFailedPage = Schema.Struct({ jobs: Schema.Array(KnowledgeJob), next: Schema.OptionFromNullOr(KnowledgeJobCursor) })
export type KnowledgeFailedPage = typeof KnowledgeFailedPage.Type
/**
 * Puts a failed job back in the queue under `engine`, the requeueing engine's own id, with its
 * attempts reset, so that engine claims it and its automatic retries apply again. @public
 */
export const KnowledgeRequeue = Schema.Struct({ scope: KnowledgeScope, jobId: KnowledgeJobId, engine: Text })
export type KnowledgeRequeue = typeof KnowledgeRequeue.Type
/** @public */
export const KnowledgeLease = Schema.Struct({ scope: KnowledgeScope, jobId: KnowledgeJobId, token: KnowledgeLeaseToken, now: Count })
export type KnowledgeLease = typeof KnowledgeLease.Type
/** Both coordinates are exclusive upper bounds on relation intervals. @public */
export const KnowledgePerspective = Schema.Struct({ validAt: Count, knownAt: Count })
export type KnowledgePerspective = typeof KnowledgePerspective.Type
/**
 * How often a memory was stated (`knowledgeMemorySupport`), counted over the live revisions among
 * its `mentions`: `episodes`, the distinct episodes they belong to (a revision's `metadata.episode`,
 * else its source id), `sources`, the revisions, and `firstSeen` and `lastSeen`, the earliest and
 * latest of their occurrence times. A forgotten revision never counts.
 * @public
 */
export const KnowledgeSupport = Schema.Struct({ episodes: Positive, sources: Positive, firstSeen: Count, lastSeen: Count })
export type KnowledgeSupport = typeof KnowledgeSupport.Type
/**
 * A memory of the profile (`LongTermMemory.profile`) and, when the engine counts it, how often it was
 * stated (`KnowledgeSupport`, from the revisions it mentions): a `KnowledgeMemory` with an optional
 * `support`, so code that reads profile memories as memories is unchanged. The profile is ordered by
 * `knowledgeProfileOrder`.
 * @public
 */
export const KnowledgeProfileMemory = Schema.Struct({ ...KnowledgeMemory.fields, support: Schema.optionalKey(KnowledgeSupport) })
  .check(Schema.makeFilter((memory) => memory.knownTo._tag === "None" || memory.knownTo.value >= memory.knownFrom || "known interval ends before it starts"))
export type KnowledgeProfileMemory = typeof KnowledgeProfileMemory.Type
/**
 * Candidate stores return independent ranked arms; the engine fuses them. An engine that counts
 * how often a memory was stated sets the memory's `support`, and one that judges event time sets
 * `past: true` on a memory whose dated event had passed at the recall's valid time
 * (`knowledgeMemoryIsPast`). An engine that collapses near-duplicates sets `alike` on the memory it
 * kept: the ids of the lower-ranked memories it folded into it, in rank order, which the result no
 * longer holds. The kept memory then carries their evidence as a corroborated one does (their spans
 * in its provenance, the revisions stating them in its mentions), so its `support` counts them and
 * the result cites their sources. A store sets none of them. @public
 */
export const KnowledgeCandidate = Schema.Union([
  Schema.TaggedStruct("Memory", {
    memory: KnowledgeMemory, score: Schema.Number, support: Schema.optionalKey(KnowledgeSupport), past: Schema.optionalKey(Schema.Boolean),
    alike: Schema.optionalKey(Schema.Array(KnowledgeMemoryId)),
  }),
  Schema.TaggedStruct("Chunk", { chunk: KnowledgeChunk, score: Schema.Number }),
])
export type KnowledgeCandidate = typeof KnowledgeCandidate.Type
/**
 * The only sources a read may return evidence from, by id, within its scope: a record is kept
 * when every span of its provenance cites one of them. An empty list returns nothing; leaving
 * the filter out reads every source of the scope. At most 1000 ids.
 * @public
 */
export const KnowledgeSourceFilter = Schema.Array(KnowledgeSourceId).check(Schema.isMaxLength(1000))
export type KnowledgeSourceFilter = typeof KnowledgeSourceFilter.Type
/** A JSON scalar a metadata filter compares a source's metadata value with. @public */
export const KnowledgeMetadataValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null])
export type KnowledgeMetadataValue = typeof KnowledgeMetadataValue.Type
/**
 * The only source revisions a read may return evidence from, by their host metadata
 * (`KnowledgeSource.metadata`), within its scope. Each key names a top-level metadata key whose
 * value must equal the given JSON scalar, or one of the listed alternatives; every key must
 * match. Equality is exact and by value: a key the metadata lacks matches nothing, `null` matches
 * only a stored `null`, an array or object value matches no scalar, and an empty list of
 * alternatives matches nothing. A record is kept when every span of its provenance cites a
 * revision that matches, judged by the metadata of the revision it cites. At most 16 keys and 100
 * alternatives a key; an empty filter matches every source.
 * @public
 */
export const KnowledgeMetadataFilter = Schema.Record(
  Schema.String,
  Schema.Union([KnowledgeMetadataValue, Schema.Array(KnowledgeMetadataValue).check(Schema.isMaxLength(100))]),
).check(Schema.isMaxProperties(16))
export type KnowledgeMetadataFilter = typeof KnowledgeMetadataFilter.Type
/** @public */
export const KnowledgeSearch = Schema.Struct({
  scope: KnowledgeScope, query: Schema.String, vector: Schema.OptionFromNullOr(KnowledgeVector),
  limit: Positive.check(Schema.isLessThanOrEqualTo(100)),
  knownAt: Schema.OptionFromNullOr(Count),
  sources: Schema.optionalKey(KnowledgeSourceFilter),
  /** Candidates only from source revisions whose metadata matches, applied before `limit`; with `sources`, both must hold. */
  metadata: Schema.optionalKey(KnowledgeMetadataFilter),
  /**
   * The least cosine similarity a semantic candidate may have with `vector`, from -1 to 1: a store
   * leaves out of the semantic arm every record scored below it, and keeps every record scored at
   * or above it (0 and below included), before `limit`, so they take no place of it. The lexical
   * arm is unaffected. Absent, the semantic arm keeps its store's own rule (the in-memory store
   * keeps scores above 0, the PostgreSQL store every score).
   */
  minSimilarity: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: -1, maximum: 1 }))),
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
/** Which earlier states a recall returns (`KnowledgeRecall.history`). @public */
export const KnowledgeRecallHistoryMode = Schema.Literals(["changes", "all", "none"])
export type KnowledgeRecallHistoryMode = typeof KnowledgeRecallHistoryMode.Type
/**
 * Whether a recall ranks past records as current ones (`KnowledgeRecall.temporal`): `current` demotes
 * a memory whose dated event has passed (`knowledgeMemoryIsPast`), `all` does not. @public
 */
export const KnowledgeRecallTemporalMode = Schema.Literals(["current", "all"])
export type KnowledgeRecallTemporalMode = typeof KnowledgeRecallTemporalMode.Type
/** @public */
export const KnowledgeRecall = Schema.Struct({
  scope: KnowledgeScope, query: Schema.String, limit: Positive.check(Schema.isLessThanOrEqualTo(100)),
  maxChars: Positive, graph: Schema.optionalKey(Schema.Union([Schema.Literal(false), Schema.Struct({ perspective: Schema.Struct({ validAt: Schema.optionalKey(Count), knownAt: Schema.optionalKey(Count) }), depth: Positive.check(Schema.isLessThanOrEqualTo(3)) })])),
  /** Candidates and graph evidence only from these sources; graph entities keep only their spans in them. */
  sources: Schema.optionalKey(KnowledgeSourceFilter),
  /** Candidates and graph evidence only from source revisions whose metadata matches; with `sources`, both must hold. */
  metadata: Schema.optionalKey(KnowledgeMetadataFilter),
  /**
   * Which earlier states to return beside the current records that replaced them
   * (`KnowledgeRecallResult.history`): `changes` (the default) those the world changed, `all` also
   * those a correction found wrong, `none` no earlier state.
   */
  history: Schema.optionalKey(KnowledgeRecallHistoryMode),
  /** The most of `maxChars` earlier states may take, from 0 to 0.5; 0.2 by default. What they leave unused goes to current records. */
  historyShare: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.5 }))),
  /**
   * How a memory engine ranks a goal, decision, action or preference whose dated event had passed at
   * the recall's valid time (`knowledgeMemoryIsPast`): `current` (the default) demotes it below
   * current records of similar relevance, `all` ranks it as any other. Either way it is returned,
   * marked `past`, never filtered out. Document retrieval, which returns no memories, ignores it.
   */
  temporal: Schema.optionalKey(KnowledgeRecallTemporalMode),
})
export type KnowledgeRecall = typeof KnowledgeRecall.Type
/**
 * How far one turn's retrieval reaches: the owner whose knowledge it reads and, when given,
 * the only sources it may read, by id (`sources`), by their metadata (`metadata`), or both
 * (`KnowledgeNarrowing` returns it).
 * @public
 */
export const KnowledgeReach = Schema.Struct({ owner: Text, sources: Schema.optionalKey(KnowledgeSourceFilter), metadata: Schema.optionalKey(KnowledgeMetadataFilter) })
export type KnowledgeReach = typeof KnowledgeReach.Type
const historyFields = {
  /** The key of the current record that replaced it: its candidate key (`memory:<id>`) or `assertion:<id>` for a relation. */
  successor: Text,
  supersession: KnowledgeSupersession,
  /** When it stopped being current: for a change, the time the earlier relation's validity ended, else when its successor was said. */
  until: Count,
}
/**
 * An earlier state a recalled current record replaced, one hop back along its `replaces`: a
 * retired memory, a relation's history copy (a change) or a retired relation (a correction).
 * @public
 */
export const KnowledgeRecallHistory = Schema.Union([
  Schema.TaggedStruct("Memory", { ...historyFields, record: KnowledgeMemory }),
  Schema.TaggedStruct("Assertion", { ...historyFields, record: KnowledgeAssertion }),
])
export type KnowledgeRecallHistory = typeof KnowledgeRecallHistory.Type
/**
 * Ranked evidence, its graph, `history`: the earlier states that recalled current records replaced,
 * in the rank order of their successors, and `sources`: the info of every source revision the
 * evidence cites, once each, in order of first citation (candidates, then relations, then entities,
 * then earlier states). A result encoded before `sources` or `history` existed decodes with none.
 * @public
 */
export const KnowledgeRecallResult = Schema.Struct({
  candidates: Schema.Array(KnowledgeCandidate), graph: KnowledgeSubgraph,
  history: Schema.Array(KnowledgeRecallHistory).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  sources: Schema.Array(KnowledgeSourceInfo).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
})
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
/** Expected storage/extraction errors preserve the original cause. @public */
export class KnowledgeError extends Schema.TaggedError<KnowledgeError>()("KnowledgeError", {
  reason: KnowledgeErrorReason, message: Schema.String, cause: Schema.optionalKey(Schema.Defect()),
}) {}
