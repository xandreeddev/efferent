import { Schema } from "effect"
import { LogEntry, RunId, SessionAddress } from "@xandreed/core"

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
  sectionOrder: Schema.Int,
  tools: Schema.Boolean,
})
export type MemoryConfig = typeof MemoryConfig.Type
/** Embedding identity must match the host's EmbeddingModel. @public */
export const memoryDefaults: MemoryConfig = {
  namespace: "default", collection: "memory", embeddingModel: "host", embeddingVersion: "1", embeddingDimensions: 1536,
  review: true, consolidate: true, queryPlanning: false, rerank: false, retrievalTimeoutMs: 10_000, worker: true, pollMs: 2_000, batchSize: 10, maxAttempts: 3, leaseMs: 180_000, modelTimeoutMs: 60_000,
  maxSourceChars: 48_000, maxExtractionChars: 48_000, maxCandidateChars: 32_000, recallChars: 8_000, recallLimit: 8, graphDepth: 2,
  sectionOrder: 700, tools: true,
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
