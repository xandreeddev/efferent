import { Schema } from "effect"

/** Owned transport failures; native values stay in the optional internal cause. @public */
export const ProcessPeerReason = Schema.Literals([
  "Input", "InvalidFrame", "InvalidUtf8", "FrameTooLarge", "InvalidEvent",
  "Output", "WriteTimeout", "Capacity", "Closed",
])
export type ProcessPeerReason = typeof ProcessPeerReason.Type

/** The failing side of the peer. @public */
export const ProcessPeerDirection = Schema.Literals(["input", "output"])
export type ProcessPeerDirection = typeof ProcessPeerDirection.Type

/** A transport failure with an owned message, never interpolated native error text. @public */
export class ProcessPeerError extends Schema.TaggedError<ProcessPeerError>()("ProcessPeerError", {
  reason: ProcessPeerReason,
  direction: ProcessPeerDirection,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const Positive = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))

/** Bounds owned by one peer; frame bytes exclude the terminating LF and optional CR. @public */
export const ProcessPeerOptions = Schema.Struct({
  maxFrameBytes: Positive,
  readChunkBytes: Positive.check(Schema.isLessThanOrEqualTo(1024 * 1024 * 1024)),
  maxPendingWrites: Positive,
  writeTimeoutMs: Positive.check(Schema.isLessThanOrEqualTo(2147483647)),
})
export type ProcessPeerOptions = typeof ProcessPeerOptions.Type

/** Defaults support attachment-bearing commands without an unbounded transport queue. @public */
export const PROCESS_PEER_DEFAULTS: ProcessPeerOptions = {
  maxFrameBytes: 24 * 1024 * 1024,
  readChunkBytes: 64 * 1024,
  maxPendingWrites: 64,
  writeTimeoutMs: 10_000,
}

/** Internal peer lifetime; a failure remains authoritative after disposal. */
export const ProcessPeerPhase = Schema.Union([
  Schema.TaggedStruct("Open", {}),
  Schema.TaggedStruct("Failed", { error: ProcessPeerError }),
  Schema.TaggedStruct("Closed", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ProcessPeerPhase = typeof ProcessPeerPhase.Type

/** Native input completion is independent of writable output. */
export const ProcessInputPhase = Schema.Union([
  Schema.TaggedStruct("Open", {}),
  Schema.TaggedStruct("Ended", {}),
  Schema.TaggedStruct("Failed", { error: ProcessPeerError }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ProcessInputPhase = typeof ProcessInputPhase.Type
