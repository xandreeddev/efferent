import { Schema } from "effect"
import { KnowledgeError } from "@xandreed/core"

const Positive = Schema.Int.check(Schema.isGreaterThan(0))
/** Native document ingestion, retrieval, and optional temporal GraphRAG. @public */
export const RagConfig = Schema.Struct({
  namespace: Schema.Trimmed.check(Schema.isNonEmpty()),
  collection: Schema.Trimmed.check(Schema.isNonEmpty()),
  /** Identity of the host's EmbeddingModel; changing it requires reindexing. */
  embeddingModel: Schema.Trimmed.check(Schema.isNonEmpty()),
  embeddingVersion: Schema.Trimmed.check(Schema.isNonEmpty()),
  embeddingDimensions: Positive,
  /** Extract and reconcile document relationships with an optional UtilityLlm. */
  graph: Schema.Boolean,
  review: Schema.Boolean,
  /** Opt in to one UtilityLlm call per search that plans complementary searches; ignored without a UtilityLlm. */
  queryPlanning: Schema.Boolean,
  /** Opt in to one UtilityLlm call per search that reranks the fused evidence; ignored without a UtilityLlm. */
  rerank: Schema.Boolean,
  /** Total foreground deadline, including helpers, embeddings, storage and traversal. */
  queryTimeoutMs: Positive,
  worker: Schema.Boolean,
  pollMs: Positive,
  batchSize: Positive.check(Schema.isLessThanOrEqualTo(100)),
  maxAttempts: Positive.check(Schema.isLessThanOrEqualTo(10)),
  leaseMs: Positive,
  modelTimeoutMs: Positive,
  maxSourceChars: Positive.check(Schema.isLessThanOrEqualTo(2_000_000)),
  /** The most source characters one graph extraction call reads; a longer document is extracted in bounded windows and merged. */
  maxExtractionChars: Positive.check(Schema.isGreaterThanOrEqualTo(1_000)),
  /**
   * Advisory: an output cap carried with each helper call in `CurrentKnowledgeHelperCall`, for a
   * host's own `UtilityLlm` that reads it. Nothing enforces it: the models plugin's `UtilityLlmLive`
   * does not read it, and sends helper calls at the model's own output limit. Absent by default.
   */
  maxHelperOutputTokens: Schema.optionalKey(Positive),
  maxCandidateChars: Positive,
  /** Target size; paragraph and heading boundaries are preferred. */
  chunkChars: Positive.check(Schema.isBetween({ minimum: 200, maximum: 16_000 })),
  overlapChars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  embeddingBatchSize: Positive.check(Schema.isLessThanOrEqualTo(100)),
  searchLimit: Positive.check(Schema.isLessThanOrEqualTo(100)),
  /**
   * The least cosine similarity, from -1 to 1, a passage's embedding must have with the question's
   * for semantic search to return it (`KnowledgeSearch.minSimilarity`): the store leaves out weaker
   * matches before its limit. Lexical matches are kept whatever their similarity. Absent by default:
   * a floor depends on the embedding model, so measure one before setting it.
   */
  minSimilarity: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: -1, maximum: 1 }))),
  evidenceChars: Positive,
  readChars: Positive,
  graphDepth: Positive.check(Schema.isLessThanOrEqualTo(3)),
  /** Add bounded retrieved evidence to each turn's recorded context. */
  recall: Schema.Boolean,
  sectionOrder: Schema.Int,
  tools: Schema.Boolean,
}).check(Schema.makeFilter((config) => config.overlapChars <= config.chunkChars / 2 || "overlapChars must not exceed half of chunkChars"))
export type RagConfig = typeof RagConfig.Type
/** Plain RAG needs only KnowledgeStore and the host's embedding service. @public */
export const ragDefaults: RagConfig = {
  namespace: "default", collection: "knowledge", embeddingModel: "host", embeddingVersion: "1", embeddingDimensions: 1536,
  graph: false, review: true, queryPlanning: false, rerank: false, queryTimeoutMs: 10_000,
  worker: true, pollMs: 2_000, batchSize: 10, maxAttempts: 3, leaseMs: 180_000, modelTimeoutMs: 60_000,
  maxSourceChars: 200_000, maxExtractionChars: 48_000, maxCandidateChars: 32_000, chunkChars: 2_000, overlapChars: 200, embeddingBatchSize: 32,
  searchLimit: 8, evidenceChars: 8_000, readChars: 8_000, graphDepth: 2, recall: false, sectionOrder: 720, tools: true,
}
/** Optional graph extraction failed on an attempt the job may still retry: the helper or its answer, not the source, was at fault. */
export class RagGraphFailed extends Schema.TaggedError<RagGraphFailed>()("RagGraphFailed", { failure: KnowledgeError }) {}
