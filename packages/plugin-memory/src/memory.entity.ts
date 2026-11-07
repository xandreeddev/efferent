import { Schema } from "effect"
import { KnowledgeRecallHistoryMode, LogEntry, RunId, SessionAddress } from "@xandreed/core"

const Positive = Schema.Int.check(Schema.isGreaterThan(0))
/** Native memory processing and bounded recall. @public */
export const MemoryConfig = Schema.Struct({
  namespace: Schema.Trimmed.check(Schema.isNonEmpty()),
  collection: Schema.Trimmed.check(Schema.isNonEmpty()),
  embeddingModel: Schema.Trimmed.check(Schema.isNonEmpty()),
  embeddingVersion: Schema.Trimmed.check(Schema.isNonEmpty()),
  embeddingDimensions: Positive,
  /** Review extracted facts against their evidence before publication. */
  review: Schema.Boolean,
  /** Reconcile updates and derive profiles/routines; false is an additive extraction ablation. */
  consolidate: Schema.Boolean,
  /** Opt in to one UtilityLlm call per recall that plans complementary searches. */
  queryPlanning: Schema.Boolean,
  /** Opt in to one UtilityLlm call per recall that reranks the fused evidence. */
  rerank: Schema.Boolean,
  retrievalTimeoutMs: Positive,
  /** Run a scoped worker; hosts can instead call process explicitly. */
  worker: Schema.Boolean,
  pollMs: Positive,
  batchSize: Positive.check(Schema.isLessThanOrEqualTo(100)),
  maxAttempts: Positive.check(Schema.isLessThanOrEqualTo(10)),
  leaseMs: Positive,
  modelTimeoutMs: Positive,
  maxSourceChars: Positive,
  /** The most source characters one extraction call reads; a longer source is extracted in bounded windows and merged. */
  maxExtractionChars: Positive.check(Schema.isGreaterThanOrEqualTo(1_000)),
  /**
   * Advisory: an output cap carried with each helper call in `CurrentKnowledgeHelperCall`, for a
   * host's own `UtilityLlm` that reads it. Nothing enforces it: the models plugin's `UtilityLlmLive`
   * does not read it, and sends helper calls at the model's own output limit. Absent by default.
   */
  maxHelperOutputTokens: Schema.optionalKey(Positive),
  maxCandidateChars: Positive,
  recallChars: Positive,
  recallLimit: Positive.check(Schema.isLessThanOrEqualTo(100)),
  graphDepth: Positive.check(Schema.isLessThanOrEqualTo(3)),
  /**
   * Where automatic recall goes. `"turn"`: the `memory.recalled` turn section, recorded as the turn's
   * context, which first catches up capture of the session's committed turns. `"off"`: no section and
   * no catch-up; the host places `memoryRecallNote` itself (a turn policy's step context, a
   * `ModelRequestHook`) or recalls only through the tools.
   */
  recallSection: Schema.Literals(["turn", "off"]),
  sectionOrder: Schema.Int,
  tools: Schema.Boolean,
  /**
   * Label each recalled record with the UTC date its source was said or written, a memory also
   * with its kind and whether it was stated or inferred, and a relation with its validity
   * (`renderMemoryRecall`'s `dates`), in the section, the recall note and `recall_memory`. A
   * record's date never changes, so a cached prefix holding it stays valid. False renders as
   * before dates were shown.
   */
  recallDates: Schema.Boolean,
  /**
   * With `recallDates`, also say today's UTC date in recalled evidence and mark a relation whose
   * validity has ended as no longer current (`renderMemoryRecall`'s `now`). The text then changes
   * from day to day, so it is off by default.
   */
  recallToday: Schema.Boolean,
  /**
   * Which earlier states recall shows beside the current records that replaced them, in an
   * "Earlier states, no longer current:" block (`KnowledgeRecall.history`): `changes` those the world
   * changed, `all` also beliefs a correction found wrong, `none` no earlier state. The section,
   * the recall note and `recall_memory` (unless its `history` parameter says otherwise) read it.
   */
  recallHistory: KnowledgeRecallHistoryMode,
  /** The most of `recallChars` earlier states may take, from 0 to 0.5 (`KnowledgeRecall.historyShare`); what they leave goes to current records. */
  recallHistoryShare: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.5 })),
  /**
   * How much recall favours a preference, routine, profile or fact stated in several episodes
   * (`KnowledgeSupport`), from 0 to 1: its fused score is multiplied by `1 + supportWeight ×
   * ln(min(episodes, 4))`, at most ×1.21 with the default 0.15, so repetition reorders records of
   * similar relevance: near the top of the lists, a record passes only records within about twelve
   * places of it. Recall also gives each memory its `support`, and a memory said in two episodes
   * or more shows how often. 0 turns support off: no read, no boost and no count, as before.
   */
  supportWeight: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  /**
   * How alike a new stated memory and an active one must be for processing to take the new one as
   * a restatement (`mergeKnowledgeRestatements`): with the same kind and exactly the same entities,
   * the cosine of their embeddings at least this (above 0, at most 1), the new memory's spans are
   * added to the earlier one as one more mention instead of being written. Memories without
   * entities never merge. A restatement the extraction names (`restates`) needs no threshold.
   * `false` turns the comparison off: only named restatements merge.
   */
  restatementSimilarity: Schema.Union([Schema.Literal(false), Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))]),
  /**
   * How far recall demotes a goal, decision, action or preference whose dated event had passed at
   * the recall's valid time (`knowledgeMemoryIsPast`), from 0 to 1: under `temporal: "current"`, the
   * default, its fused score is multiplied by this after the support factor, so a current record of
   * similar relevance ranks above it. The record is still returned and labelled past; the profile
   * leaves it out whatever the weight. 1 turns the demotion off.
   */
  pastEventWeight: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  /**
   * The least cosine similarity, from -1 to 1, a memory's embedding must have with the question's
   * for recall's semantic search to return it (`KnowledgeSearch.minSimilarity`): the store leaves
   * out weaker matches before its limit. Lexical matches are kept whatever their similarity. Absent
   * by default: a floor depends on the embedding model, so measure one before setting it.
   */
  recallMinSimilarity: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: -1, maximum: 1 }))),
  /**
   * How alike two recalled memories must be for recall to show them as one, above 0 and at most 1:
   * after weighting, in rank order, a memory of the same kind and event time as a memory ranked
   * above it and kept, whose embedding's cosine with that memory's is at least this, is folded into
   * it: it leaves the result before reranking and selection, freeing its place and its share of
   * the budget, and is named in the kept candidate's `alike`; the kept memory carries its spans and
   * mentions, so its `support` counts both and both sources are cited. Passages are never folded,
   * and nothing changes in the store. `false` turns collapsing off.
   */
  recallCollapseSimilarity: Schema.Union([Schema.Literal(false), Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))]),
})
export type MemoryConfig = typeof MemoryConfig.Type
/** Embedding identity must match the host's EmbeddingModel. @public */
export const memoryDefaults: MemoryConfig = {
  namespace: "default", collection: "memory", embeddingModel: "host", embeddingVersion: "1", embeddingDimensions: 1536,
  review: true, consolidate: true, queryPlanning: false, rerank: false, retrievalTimeoutMs: 10_000, worker: true, pollMs: 2_000, batchSize: 10, maxAttempts: 3, leaseMs: 180_000, modelTimeoutMs: 60_000,
  maxSourceChars: 48_000, maxExtractionChars: 48_000, maxCandidateChars: 32_000, recallChars: 8_000, recallLimit: 8, graphDepth: 2,
  recallSection: "turn", sectionOrder: 700, tools: true, recallDates: true, recallToday: false,
  recallHistory: "changes", recallHistoryShare: 0.2, supportWeight: 0.15, restatementSimilarity: 0.92, pastEventWeight: 0.5,
  recallCollapseSimilarity: 0.95,
}

/** Bounded journal capture over committed turns; no provider processing runs inside the observer. @public */
export const MemoryCaptureConfig = Schema.Struct({
  namespace: Schema.Trimmed.check(Schema.isNonEmpty()),
  collection: Schema.Trimmed.check(Schema.isNonEmpty()),
  maxSourceChars: Positive,
  maxTurns: Positive.check(Schema.isLessThanOrEqualTo(100)),
  pageSize: Positive.check(Schema.isLessThanOrEqualTo(5_000)),
  maxPages: Positive.check(Schema.isLessThanOrEqualTo(1_000)),
})
export type MemoryCaptureConfig = typeof MemoryCaptureConfig.Type
/** @public */
export const memoryCaptureDefaults: MemoryCaptureConfig = { namespace: "default", collection: "memory", maxSourceChars: 48_000, maxTurns: 10, pageSize: 500, maxPages: 100 }

/** Plugin-owned checkpoints; the framework's journal schemas stay unchanged. */
export const MemoryCaptureAck = Schema.Struct({ namespace: Schema.String, collection: Schema.String, version: Schema.Literal("1"), through: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
/**
 * One committed turn as capture is about to store it, given to the host's `MemoryCaptureAdmission`:
 * its session, run and turn number, the evidence text capture renders from it and the committed
 * entries that text comes from. @public
 */
export const MemoryCaptureTurn = Schema.Struct({
  session: SessionAddress,
  runId: RunId,
  turn: Positive,
  /** The evidence capture stores when the turn is admitted as is. */
  text: Schema.String,
  /** The turn's committed journal entries, in order. */
  entries: Schema.Array(LogEntry),
})
export type MemoryCaptureTurn = typeof MemoryCaptureTurn.Type
/**
 * What capture stores of one committed turn: `Admit` its evidence, or the host's `text` in its
 * place; `Refuse` stores nothing, and the checkpoint still moves past the turn. @public
 */
export const MemoryCaptureDecision = Schema.Union([
  Schema.TaggedStruct("Admit", { text: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())) }),
  Schema.TaggedStruct("Refuse", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type MemoryCaptureDecision = typeof MemoryCaptureDecision.Type
/** @public */
export const MemorySyncResult = Schema.Struct({
  sources: Schema.Int, through: Schema.Int, hasMore: Schema.Boolean,
  stalled: Schema.optionalKey(Schema.Literals(["open-turn", "page-limit"])),
  /** The turn numbers the host's admission refused in this sync, in order; absent when none was. */
  refused: Schema.optionalKey(Schema.Array(Positive)),
})
export type MemorySyncResult = typeof MemorySyncResult.Type
