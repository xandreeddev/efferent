import { Context } from "effect"
import type { Effect, Option } from "effect"
import type {
  KnowledgeCandidates, KnowledgeChunk, KnowledgeChunkId, KnowledgeClaim, KnowledgeEnqueue,
  KnowledgeError, KnowledgeJob, KnowledgeJobId, KnowledgeLease, KnowledgeMemory, KnowledgeMemoryId,
  KnowledgePending, KnowledgeRecall, KnowledgeRecallResult, KnowledgeScope, KnowledgeSearch, KnowledgeSnapshot, KnowledgeSource,
  KnowledgeSourceId, KnowledgeSourceRef, KnowledgeStage, KnowledgeSubgraph, KnowledgeTraversal,
} from "../knowledge/knowledge.entity.js"

/**
 * Durable source processing and derived indexes. Replaying identical source/revision/engine
 * returns its original job. Conflicting content or source/job reuse fails without changes.
 * Discovery (`pending`) and `claim` see only jobs recorded under the requested engine.
 * Staging verifies the unexpired lease, current scope version and source provenance.
 * Publication verifies the unexpired lease, current source revision, provenance and scope CAS,
 * atomically replaces that source's indexes, retires requested records, and completes the job.
 * Forget tombstones every revision, cancels its jobs, removes dependent derivations, and clears
 * all durable staged extractions in that scope. In-flight stale extractions cannot be restaged.
 * Absence is Option; lease/version/tombstone violations are KnowledgeError.
 * @public
 */
export interface KnowledgeIndex {
  readonly enqueue: (input: KnowledgeEnqueue) => Effect.Effect<KnowledgeJob, KnowledgeError>
  readonly claim: (input: KnowledgeClaim) => Effect.Effect<Option.Option<KnowledgeJob>, KnowledgeError>
  readonly pending: (input: KnowledgePending) => Effect.Effect<ReadonlyArray<KnowledgeJob>, KnowledgeError>
  readonly renew: (lease: KnowledgeLease, leaseMs: number) => Effect.Effect<KnowledgeJob, KnowledgeError>
  readonly stage: (lease: KnowledgeLease, stage: KnowledgeStage) => Effect.Effect<void, KnowledgeError>
  readonly publish: (lease: KnowledgeLease) => Effect.Effect<void, KnowledgeError>
  readonly fail: (lease: KnowledgeLease, message: string) => Effect.Effect<void, KnowledgeError>
  readonly retry: (scope: KnowledgeScope, jobId: KnowledgeJobId) => Effect.Effect<KnowledgeJob, KnowledgeError>
  readonly status: (scope: KnowledgeScope, jobId: KnowledgeJobId) => Effect.Effect<Option.Option<KnowledgeJob>, KnowledgeError>
  readonly snapshot: (scope: KnowledgeScope) => Effect.Effect<KnowledgeSnapshot, KnowledgeError>
  readonly search: (query: KnowledgeSearch) => Effect.Effect<KnowledgeCandidates, KnowledgeError>
  readonly source: (scope: KnowledgeScope, ref: KnowledgeSourceRef) => Effect.Effect<Option.Option<KnowledgeSource>, KnowledgeError>
  /** Explicit immutable identity reads include retired history until its evidence is forgotten. */
  readonly memory: (scope: KnowledgeScope, id: KnowledgeMemoryId) => Effect.Effect<Option.Option<KnowledgeMemory>, KnowledgeError>
  readonly chunk: (scope: KnowledgeScope, id: KnowledgeChunkId) => Effect.Effect<Option.Option<KnowledgeChunk>, KnowledgeError>
  readonly forget: (scope: KnowledgeScope, id: KnowledgeSourceId, now: number) => Effect.Effect<void, KnowledgeError>
  readonly traverse: (query: KnowledgeTraversal) => Effect.Effect<KnowledgeSubgraph, KnowledgeError>
}
/** Cross-conversation memory storage, independently bindable from document retrieval. @public */
export class MemoryStore extends Context.Service<MemoryStore, KnowledgeIndex>()("@xandreed/core/MemoryStore") {}
/** Document retrieval storage. Collections never implicitly cross into personal memory. @public */
export class KnowledgeStore extends Context.Service<KnowledgeStore, KnowledgeIndex>()("@xandreed/core/KnowledgeStore") {}
/** Temporal graph reads share the providing store's transactions and isolation. @public */
export class TemporalGraph extends Context.Service<TemporalGraph, {
  readonly traverse: (query: KnowledgeTraversal) => Effect.Effect<KnowledgeSubgraph, KnowledgeError>
}>()("@xandreed/core/TemporalGraph") {}
/** Native long-term memory capture, processing and bounded evidence retrieval. @public */
export class LongTermMemory extends Context.Service<LongTermMemory, {
  readonly capture: (input: KnowledgeEnqueue) => Effect.Effect<KnowledgeJob, KnowledgeError>
  readonly process: (scope: KnowledgeScope, limit: number) => Effect.Effect<number, KnowledgeError>
  readonly recall: (input: KnowledgeRecall) => Effect.Effect<KnowledgeRecallResult, KnowledgeError>
  readonly profile: (scope: KnowledgeScope) => Effect.Effect<ReadonlyArray<KnowledgeMemory>, KnowledgeError>
  readonly source: (scope: KnowledgeScope, ref: KnowledgeSourceRef) => Effect.Effect<Option.Option<KnowledgeSource>, KnowledgeError>
  readonly status: (scope: KnowledgeScope, jobId: KnowledgeJobId) => Effect.Effect<Option.Option<KnowledgeJob>, KnowledgeError>
  readonly retry: (scope: KnowledgeScope, jobId: KnowledgeJobId) => Effect.Effect<KnowledgeJob, KnowledgeError>
  readonly forget: (scope: KnowledgeScope, id: KnowledgeSourceId) => Effect.Effect<void, KnowledgeError>
}>()("@xandreed/core/LongTermMemory") {}
/** Native RAG ingestion and retrieval. Graph expansion is opt-in on each recall. @public */
export class Knowledge extends Context.Service<Knowledge, {
  readonly ingest: (input: KnowledgeEnqueue) => Effect.Effect<KnowledgeJob, KnowledgeError>
  readonly process: (scope: KnowledgeScope, limit: number) => Effect.Effect<number, KnowledgeError>
  readonly retrieve: (input: KnowledgeRecall) => Effect.Effect<KnowledgeRecallResult, KnowledgeError>
  readonly source: (scope: KnowledgeScope, ref: KnowledgeSourceRef) => Effect.Effect<Option.Option<KnowledgeSource>, KnowledgeError>
  readonly status: (scope: KnowledgeScope, jobId: KnowledgeJobId) => Effect.Effect<Option.Option<KnowledgeJob>, KnowledgeError>
  readonly retry: (scope: KnowledgeScope, jobId: KnowledgeJobId) => Effect.Effect<KnowledgeJob, KnowledgeError>
  readonly forget: (scope: KnowledgeScope, id: KnowledgeSourceId) => Effect.Effect<void, KnowledgeError>
}>()("@xandreed/core/Knowledge") {}
