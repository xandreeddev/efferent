import { Schema } from "effect"
import { UiOutputReceipt, UiOutputScope, UiRelease } from "./render-output.entity.js"

const Id = Schema.NonEmptyTrimmedString
const Json = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const Generation = Schema.Int.pipe(Schema.positive())

/** One addressable visual region a host renders into (a page, a canvas, a panel). */
export const SurfaceScope = Schema.Struct({
  ...UiOutputScope.fields,
  surfaceId: Id,
  /** The version this render builds on, e.g. the page the user was looking at. */
  baseVersion: Schema.OptionFromNullOr(Schema.String),
})
export type SurfaceScope = typeof SurfaceScope.Type

/** One node of a snapshot: an exact component release, JSON props and the evidence ids behind them. */
export const RenderNode = Schema.Struct({ nodeId: Id, release: UiRelease, props: Json, evidence: Schema.Array(Id) })
export type RenderNode = typeof RenderNode.Type

/**
 * The host's whole visual representation at one moment. `spec` is opaque JSON
 * (a layout, a tree, sections); `nodes` are committed one by one; placeholders
 * are node ids a later `fill` may commit even after the surface is frozen.
 */
export const RenderSnapshot = Schema.Struct({
  phase: Schema.Literal("partial", "complete"),
  spec: Json,
  nodes: Schema.Array(RenderNode),
  placeholders: Schema.optionalWith(Schema.Array(Id), { default: () => [] }),
})
export type RenderSnapshot = typeof RenderSnapshot.Type
export type RenderSnapshotInput = typeof RenderSnapshot.Encoded

export const FreezeReason = Schema.Literal("interaction", "completion")
export type FreezeReason = typeof FreezeReason.Type

/** What a store persists and hydrates. Every record names its surface and the message it was rendered for. */
export const SurfacePlanned = Schema.TaggedStruct("SurfacePlanned", {
  surfaceId: Id,
  messageId: Id,
  versionId: Id,
  generation: Generation,
  baseVersionId: Schema.OptionFromNullOr(Schema.String),
  phase: Schema.Literal("partial", "complete"),
  spec: Json,
  nodes: Schema.Array(Id),
  placeholders: Schema.Array(Id),
  signature: Schema.String,
})
export type SurfacePlanned = typeof SurfacePlanned.Type

export const SurfaceCommitted = Schema.TaggedStruct("SurfaceCommitted", {
  surfaceId: Id,
  messageId: Id,
  versionId: Id,
  nodeId: Id,
  component: Id,
  receipt: UiOutputReceipt,
})
export type SurfaceCommitted = typeof SurfaceCommitted.Type

export const SurfaceCompleted = Schema.TaggedStruct("SurfaceCompleted", {
  surfaceId: Id,
  messageId: Id,
  versionId: Id,
  generation: Generation,
  phase: Schema.Literal("partial", "complete"),
  frozen: Schema.Boolean,
})
export type SurfaceCompleted = typeof SurfaceCompleted.Type

export const SurfaceFrozen = Schema.TaggedStruct("SurfaceFrozen", {
  surfaceId: Id,
  messageId: Id,
  versionId: Id,
  reason: FreezeReason,
})
export type SurfaceFrozen = typeof SurfaceFrozen.Type

export const SurfaceRecord = Schema.Union(SurfacePlanned, SurfaceCommitted, SurfaceCompleted, SurfaceFrozen)
export type SurfaceRecord = typeof SurfaceRecord.Type

/** The current message's view of a surface. `frozen` is advisory: the store's guard is authoritative. */
export const SurfaceState = Schema.Struct({
  surfaceId: Id,
  version: Schema.OptionFromNullOr(Schema.String),
  generation: Schema.Int.pipe(Schema.nonNegative()),
  frozen: Schema.Boolean,
  completed: Schema.Boolean,
  components: Schema.Array(Schema.String),
  placeholders: Schema.Array(Schema.String),
  pending: Schema.Boolean,
})
export type SurfaceState = typeof SurfaceState.Type

export const PublishResult = Schema.Struct({
  version: Schema.OptionFromNullOr(Schema.String),
  generation: Schema.Int.pipe(Schema.nonNegative()),
  changed: Schema.Boolean,
  frozen: Schema.Boolean,
})
export type PublishResult = typeof PublishResult.Type

export class RenderError extends Schema.TaggedError<RenderError>()("RenderError", {
  code: Schema.Literal("invalid", "frozen", "conflict", "forbidden", "storage", "unavailable"),
  message: Schema.String,
}) {}
