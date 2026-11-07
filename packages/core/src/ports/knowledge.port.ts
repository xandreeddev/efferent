import { Context, Effect } from "effect"
import type { Option } from "effect"
import type {
  KnowledgeCandidates, KnowledgeChunk, KnowledgeChunkId, KnowledgeClaim, KnowledgeEnqueue,
  KnowledgeError, KnowledgeFailedPage, KnowledgeFailedQuery, KnowledgeJob, KnowledgeJobFailure, KnowledgeJobId, KnowledgeLease, KnowledgeMemory, KnowledgeMemoryId, KnowledgeProfileMemory,
  KnowledgePending, KnowledgeReach, KnowledgeRecall, KnowledgeRecallResult, KnowledgeScope, KnowledgeSearch, KnowledgeSnapshot, KnowledgeSource,
  KnowledgeRequeue, KnowledgeSourceId, KnowledgeSourceInfo, KnowledgeSourceRef, KnowledgeStage, KnowledgeSubgraph, KnowledgeTraversal,
} from "../knowledge/knowledge.entity.js"
import type { RunContext } from "./run-context.port.js"

/**
 * Durable source processing and derived indexes. Replaying identical source/revision/engine
 * returns its original job. Conflicting content or source/job reuse fails without changes.
 * Discovery (`pending`) and `claim` see only jobs recorded under the requested engine.
 * `fail` records why the leased attempt failed (`KnowledgeJobFailure`) on its `Failed` phase, which
 * `status` returns; `retry` requeues a failed job, `requeue` resets it for an engine, and `failed`
 * lists failed jobs across owners (of any engine) so a host need not remember their ids.
 * Staging verifies the unexpired lease, current scope version and source provenance, and keeps
 * the stage, its notes included, on the job through retry and publication.
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
  readonly fail: (lease: KnowledgeLease, failure: KnowledgeJobFailure) => Effect.Effect<void, KnowledgeError>
  /** Requeues a failed job under its own engine, keeping its attempts: an engine's bounded automatic retry. */
  readonly retry: (scope: KnowledgeScope, jobId: KnowledgeJobId) => Effect.Effect<KnowledgeJob, KnowledgeError>
  /**
   * Requeues a failed job under `engine` with its attempts reset: a host's retry after the
   * engine's own retries ran out, or after its engine id changed (a new extraction version or
   * embedding space). The stage is kept only when `engine` is the job's own; another engine's stage
   * is discarded. Fails `Tombstoned` when its source was forgotten, whatever its phase (forgetting
   * cancels the source's jobs); else `Conflict` unless the job is failed, when a newer revision
   * superseded its source revision, or when another job already holds that revision under `engine`.
   */
  readonly requeue: (input: KnowledgeRequeue) => Effect.Effect<KnowledgeJob, KnowledgeError>
  /** Failed jobs across owners in one namespace, oldest first, page by page (`KnowledgeFailedQuery`). */
  readonly failed: (query: KnowledgeFailedQuery) => Effect.Effect<KnowledgeFailedPage, KnowledgeError>
  readonly status: (scope: KnowledgeScope, jobId: KnowledgeJobId) => Effect.Effect<Option.Option<KnowledgeJob>, KnowledgeError>
  readonly snapshot: (scope: KnowledgeScope) => Effect.Effect<KnowledgeSnapshot, KnowledgeError>
  /**
   * Ranked lexical and semantic arms of at most `limit` each. A `sources` or `metadata` narrowing
   * applies before ranking and the limit, so a narrow filter still returns its best matches.
   */
  readonly search: (query: KnowledgeSearch) => Effect.Effect<KnowledgeCandidates, KnowledgeError>
  readonly source: (scope: KnowledgeScope, ref: KnowledgeSourceRef) => Effect.Effect<Option.Option<KnowledgeSource>, KnowledgeError>
  /**
   * The info of the listed revisions, without their text, in one read: once each, in the order
   * first listed. A revision that is absent from the scope or forgotten is left out.
   */
  readonly sourceInfo: (scope: KnowledgeScope, refs: ReadonlyArray<KnowledgeSourceRef>) => Effect.Effect<ReadonlyArray<KnowledgeSourceInfo>, KnowledgeError>
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
  /** Bounded evidence; its `sources` hold the info (times, metadata) of every revision it cites. */
  readonly recall: (input: KnowledgeRecall) => Effect.Effect<KnowledgeRecallResult, KnowledgeError>
  /**
   * The current preference and profile memories, but those whose dated event has passed
   * (`knowledgeMemoryIsPast`), each with its `support` (`knowledgeMemorySupport` of the revisions it
   * mentions) unless the engine is set not to count support, ordered by `knowledgeProfileOrder`:
   * more episodes first, then said more recently, then by id, whatever order the store keeps.
   */
  readonly profile: (scope: KnowledgeScope) => Effect.Effect<ReadonlyArray<KnowledgeProfileMemory>, KnowledgeError>
  readonly source: (scope: KnowledgeScope, ref: KnowledgeSourceRef) => Effect.Effect<Option.Option<KnowledgeSource>, KnowledgeError>
  readonly status: (scope: KnowledgeScope, jobId: KnowledgeJobId) => Effect.Effect<Option.Option<KnowledgeJob>, KnowledgeError>
  /**
   * Requeues a failed job of the engine's collection under the engine's current id with its
   * attempts reset (`KnowledgeIndex.requeue`), a job failed under an older id of the engine included.
   */
  readonly retry: (scope: KnowledgeScope, jobId: KnowledgeJobId) => Effect.Effect<KnowledgeJob, KnowledgeError>
  readonly forget: (scope: KnowledgeScope, id: KnowledgeSourceId) => Effect.Effect<void, KnowledgeError>
}>()("@xandreed/core/LongTermMemory") {}
/** Native RAG ingestion and retrieval. Graph expansion is opt-in on each recall. @public */
export class Knowledge extends Context.Service<Knowledge, {
  readonly ingest: (input: KnowledgeEnqueue) => Effect.Effect<KnowledgeJob, KnowledgeError>
  readonly process: (scope: KnowledgeScope, limit: number) => Effect.Effect<number, KnowledgeError>
  /** Bounded evidence; its `sources` hold the info (times, metadata) of every revision it cites. */
  readonly retrieve: (input: KnowledgeRecall) => Effect.Effect<KnowledgeRecallResult, KnowledgeError>
  readonly source: (scope: KnowledgeScope, ref: KnowledgeSourceRef) => Effect.Effect<Option.Option<KnowledgeSource>, KnowledgeError>
  readonly status: (scope: KnowledgeScope, jobId: KnowledgeJobId) => Effect.Effect<Option.Option<KnowledgeJob>, KnowledgeError>
  /**
   * Requeues a failed job of the engine's collection under the engine's current id with its
   * attempts reset (`KnowledgeIndex.requeue`), a job failed under an older id of the engine included.
   */
  readonly retry: (scope: KnowledgeScope, jobId: KnowledgeJobId) => Effect.Effect<KnowledgeJob, KnowledgeError>
  readonly forget: (scope: KnowledgeScope, id: KnowledgeSourceId) => Effect.Effect<void, KnowledgeError>
}>()("@xandreed/core/Knowledge") {}

/**
 * Narrows one turn's retrieval without replacing the tools or sections that read it: the
 * document and memory capabilities ask it, once per tool call or section render, for the
 * run's `KnowledgeReach`, and read the owner it names (in the engine's own namespace and
 * collection) and, when it lists sources or a metadata filter, only those sources
 * (`KnowledgeRecall.sources` and `.metadata`; a source read outside them is not found). It
 * never widens a write: a saved or forgotten memory stays on the session owner's memory, and a
 * source outside the listed ones cannot be forgotten (it is not found). Forgetting removes every
 * revision of a source, which a metadata filter (judging revisions) cannot vouch for, so while
 * one is set no source can be forgotten: each is not found. The default reaches the
 * session owner's whole collection. A host provides its own
 * among the agent's or the turn's services; a failure is the capability's unavailability.
 * @public
 */
export const KnowledgeNarrowing = Context.Reference<{
  readonly reach: (run: Context.Service.Shape<typeof RunContext>) => Effect.Effect<KnowledgeReach, KnowledgeError>
}>("@xandreed/core/KnowledgeNarrowing", { defaultValue: () => ({ reach: (run) => Effect.succeed({ owner: run.session.owner }) }) })
