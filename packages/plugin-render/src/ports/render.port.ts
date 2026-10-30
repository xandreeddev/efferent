import { Context } from "effect"
import type { Effect, Option, Stream } from "effect"
import type { UiOutputProposal, UiOutputReceipt } from "../domain/render-output.entity.js"
import type {
  FreezeReason,
  PublishResult,
  RenderError,
  RenderNode,
  RenderSnapshotInput,
  SurfaceCompleted,
  SurfaceFrozen,
  SurfacePlanned,
  SurfaceRecord,
  SurfaceScope,
  SurfaceState,
  VersionId,
} from "../domain/render-surface.entity.js"
import type { FeedFrame, FeedPayload, FeedScope, JournalRecord } from "../domain/feed-frame.entity.js"

/**
 * The host's durable surface storage. Every write is fenced by the scope.
 * A surface is the scope's thread, principal and `surfaceId`: its records
 * never mix with another thread's or principal's, even under the same ids.
 * - Every write (`plan`, `commit`, `complete`, `freeze`) MUST fail with code
 *   `forbidden`, inside its transaction, when `scope.fence` is lower than the
 *   highest fence the store has accepted for the surface and message; a
 *   write it accepts raises that fence to its own.
 * - `plan` MUST fail with code `frozen` inside the same transaction when a
 *   `SurfaceFrozen` (with or without a version) exists for the surface and
 *   message.
 * - `plan` MUST fail with code `conflict` inside the same transaction unless
 *   `record.generation` is the highest generation planned for the surface
 *   and message plus one (1 for the first): two writers of one message never
 *   plan the same version, and none skips one.
 * - `commit` is idempotent by `proposal.operationId` within the thread and
 *   principal; reusing an id with a different proposal fails with `conflict`.
 *   It persists a `SurfaceCommitted`.
 * - `freeze` persists a `SurfaceFrozen`; it may drop one for a surface and
 *   message already frozen, never one for another surface.
 * - `hydrate` returns that surface's records, in write order, for every
 *   message, and nothing else.
 */
export class RenderStore extends Context.Service<RenderStore, {
  readonly hydrate: (scope: SurfaceScope) => Effect.Effect<ReadonlyArray<SurfaceRecord>, RenderError>
  readonly plan: (scope: SurfaceScope, record: SurfacePlanned) => Effect.Effect<void, RenderError>
  readonly commit: (scope: SurfaceScope, write: { readonly versionId: VersionId; readonly proposal: UiOutputProposal }) => Effect.Effect<UiOutputReceipt, RenderError>
  readonly complete: (scope: SurfaceScope, record: SurfaceCompleted) => Effect.Effect<void, RenderError>
  readonly freeze: (scope: SurfaceScope, record: SurfaceFrozen) => Effect.Effect<void, RenderError>
  readonly annotate: (scope: SurfaceScope, kind: string, data: Readonly<Record<string, unknown>>) => Effect.Effect<void, RenderError>
}>()("efferent/render/Store") {}

/** Everything a host does with one surface during a run. Writes are serialized. */
export interface RenderSurface {
  readonly scope: SurfaceScope
  /** The records hydrated when the surface was opened, for every message (e.g. the page being edited). */
  readonly records: ReadonlyArray<SurfaceRecord>
  readonly state: Effect.Effect<SurfaceState>
  /**
   * Versioned and deduplicated: identical content opens no new generation, but commits the nodes an
   * earlier attempt left uncommitted (`changed` is then true) before it completes. A frozen surface
   * records a frozen, partial completion instead of failing (none for a version already complete).
   * When another writer planned first (`conflict`), it re-hydrates and decides once more: it resumes
   * that version if it holds the same content, else plans the next one. A second conflict, or a
   * lower fence (`forbidden`), fails the publish.
   */
  readonly publish: (snapshot: RenderSnapshotInput) => Effect.Effect<PublishResult, RenderError>
  /** Commit a node into a declared placeholder of the current version; allowed after freezing. */
  readonly fill: (placeholder: string, node: RenderNode) => Effect.Effect<UiOutputReceipt, RenderError>
  /** Run a stream of snapshots in the background through the host's `fork`, one preparation at a time. Failures are annotated `render.preparation-failed` and passed to `recover`. */
  readonly prepare: <E>(work: Stream.Stream<RenderSnapshotInput, E>, recover: (error: E | RenderError) => Effect.Effect<void>) => Effect.Effect<void>
  /** Wait for every preparation started so far. */
  readonly settled: Effect.Effect<void>
  /** Freeze the surface for this message, at the version it reached or before the first one. */
  readonly freeze: (reason: FreezeReason) => Effect.Effect<void, RenderError>
  readonly annotate: (kind: string, data: Readonly<Record<string, unknown>>) => Effect.Effect<void, RenderError>
}

export interface RenderOpenOptions {
  /** The host's background runner (e.g. its turn tasks), so preparations live and die with the host's unit of work. */
  readonly fork: (tag: string, work: Effect.Effect<void>) => Effect.Effect<void>
}

export class Render extends Context.Service<Render, {
  readonly open: (scope: SurfaceScope, options: RenderOpenOptions) => Effect.Effect<RenderSurface, RenderError>
}>()("efferent/render/Render") {}

/** The host's journal, read after a cursor. The host authorizes the feed's principal. */
export class JournalTail extends Context.Service<JournalTail, {
  readonly read: (feed: FeedScope, after: number) => Effect.Effect<ReadonlyArray<JournalRecord>, RenderError>
  /**
   * Optional wake signal: each element means the feed's journal may have new
   * records, and the feed polls at once instead of waiting out its interval.
   * Polling stays the fallback; a failed or ended stream only stops waking.
   */
  readonly changes?: (feed: FeedScope) => Stream.Stream<void, RenderError>
}>()("efferent/render/JournalTail") {}

/** Maps a journal record to what a client receives; `None` skips it (the cursor still advances). */
export type FeedProjection = (record: JournalRecord) => Effect.Effect<Option.Option<FeedPayload>, RenderError>

export class RenderFeed extends Context.Service<RenderFeed, {
  readonly frames: (feed: FeedScope, after: number, project: FeedProjection) => Stream.Stream<FeedFrame, RenderError>
}>()("efferent/render/Feed") {}

/** A wire: SSE, WebSocket, or anything that can carry text frames to one peer. */
export interface RenderTransport<Peer> {
  readonly id: string
  readonly serve: (frames: Stream.Stream<FeedFrame, RenderError>, peer: Peer) => Effect.Effect<void>
}

export interface SsePeer {
  readonly write: (chunk: string) => Effect.Effect<void>
  /** Completes when the client disconnects. */
  readonly closed: Effect.Effect<void>
}

export interface SocketPeer {
  readonly send: (text: string) => Effect.Effect<void>
  readonly closed: Effect.Effect<void>
}
