import { Schema, Effect } from "effect"
import { NodeId, RenderMessageId, UiOutputReceipt, UiOutputScope, UiRelease } from "./render-output.entity.js"

const Id = Schema.Trimmed.check(Schema.isNonEmpty())
/** Opaque JSON: a spec or a node's props, every value JSON. */
const Json = Schema.JsonObject
const Generation = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

/** One addressable visual region of a thread (a page, a canvas, a panel). */
export const SurfaceId = Id.pipe(Schema.brand("SurfaceId"))
export type SurfaceId = typeof SurfaceId.Type

/** A surface's version for one message, `<messageId>:v<generation>` (`versionIdOf`). */
export const VersionId = Id.pipe(Schema.brand("VersionId"))
export type VersionId = typeof VersionId.Type

/**
 * A version a render builds on, as the host names it and a plan stores it:
 * `VersionId`'s brand without its checks, so plans stored before the brand
 * still decode.
 */
const BaseVersionId = Schema.String.pipe(Schema.brand("VersionId"))

/** One addressable visual region a host renders into (a page, a canvas, a panel). */
export const SurfaceScope = Schema.Struct({
  ...UiOutputScope.fields,
  surfaceId: SurfaceId,
  /** The version this render builds on, e.g. the page the user was looking at. */
  baseVersion: Schema.OptionFromNullOr(BaseVersionId),
})
export type SurfaceScope = typeof SurfaceScope.Type

/** One node of a snapshot: an exact component release, JSON props and the evidence ids behind them. */
export const RenderNode = Schema.Struct({ nodeId: NodeId, release: UiRelease, props: Json, evidence: Schema.Array(Id) })
export type RenderNode = typeof RenderNode.Type

/**
 * The host's whole visual representation at one moment. `spec` is opaque JSON
 * (a layout, a tree, sections); `nodes` are committed one by one; placeholders
 * are node ids a later `fill` may commit even after the surface is frozen.
 */
export const RenderSnapshot = Schema.Struct({
  phase: Schema.Literals(["partial", "complete"]),
  spec: Json,
  nodes: Schema.Array(RenderNode),
  placeholders: Schema.Array(NodeId).pipe(Schema.withDecodingDefaultType(Effect.sync(() => [])), Schema.withConstructorDefault(Effect.sync(() => []))),
})
export type RenderSnapshot = typeof RenderSnapshot.Type
export type RenderSnapshotInput = typeof RenderSnapshot.Encoded

export const FreezeReason = Schema.Literals(["interaction", "completion"])
export type FreezeReason = typeof FreezeReason.Type

/**
 * What a store persists and hydrates. Every record names its surface and the
 * message it was rendered for; the store keeps it under the scope's thread
 * and principal.
 */
export const SurfacePlanned = Schema.TaggedStruct("SurfacePlanned", {
  surfaceId: SurfaceId,
  messageId: RenderMessageId,
  versionId: VersionId,
  generation: Generation,
  baseVersionId: Schema.OptionFromNullOr(BaseVersionId),
  phase: Schema.Literals(["partial", "complete"]),
  spec: Json,
  nodes: Schema.Array(NodeId),
  placeholders: Schema.Array(NodeId),
  signature: Schema.String,
})
export type SurfacePlanned = typeof SurfacePlanned.Type

export const SurfaceCommitted = Schema.TaggedStruct("SurfaceCommitted", {
  surfaceId: SurfaceId,
  messageId: RenderMessageId,
  versionId: VersionId,
  nodeId: NodeId,
  component: Id,
  receipt: UiOutputReceipt,
})
export type SurfaceCommitted = typeof SurfaceCommitted.Type

export const SurfaceCompleted = Schema.TaggedStruct("SurfaceCompleted", {
  surfaceId: SurfaceId,
  messageId: RenderMessageId,
  versionId: VersionId,
  generation: Generation,
  phase: Schema.Literals(["partial", "complete"]),
  frozen: Schema.Boolean,
})
export type SurfaceCompleted = typeof SurfaceCompleted.Type

/** The surface is frozen for the message, at the version it reached, or before any version (`null` when encoded). */
export const SurfaceFrozen = Schema.TaggedStruct("SurfaceFrozen", {
  surfaceId: SurfaceId,
  messageId: RenderMessageId,
  versionId: Schema.OptionFromNullOr(VersionId),
  reason: FreezeReason,
})
export type SurfaceFrozen = typeof SurfaceFrozen.Type

export const SurfaceRecord = Schema.Union([SurfacePlanned, SurfaceCommitted, SurfaceCompleted, SurfaceFrozen])
export type SurfaceRecord = typeof SurfaceRecord.Type

/** The current message's view of a surface. `frozen` is advisory: the store's guard is authoritative. */
export const SurfaceState = Schema.Struct({
  surfaceId: SurfaceId,
  version: Schema.OptionFromNullOr(VersionId),
  generation: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  frozen: Schema.Boolean,
  completed: Schema.Boolean,
  components: Schema.Array(Schema.String),
  placeholders: Schema.Array(Schema.String),
  pending: Schema.Boolean,
})
export type SurfaceState = typeof SurfaceState.Type

export const PublishResult = Schema.Struct({
  version: Schema.OptionFromNullOr(VersionId),
  generation: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  changed: Schema.Boolean,
  frozen: Schema.Boolean,
})
export type PublishResult = typeof PublishResult.Type

export class RenderError extends Schema.TaggedError<RenderError>()("RenderError", {
  code: Schema.Literals(["invalid", "frozen", "conflict", "forbidden", "storage", "unavailable"]),
  message: Schema.String,
}) {}
