import { Schema } from "effect"

/** The Messages API's supported prompt-cache lifetimes. */
export const PromptCacheTtl = Schema.Literals(["5m", "1h"])
export type PromptCacheTtl = typeof PromptCacheTtl.Type

/** Per-model prompt caching; Off preserves and validates explicit caller controls. @public */
export const PromptCacheSettings = Schema.Union([
  Schema.TaggedStruct("Auto", { ttl: PromptCacheTtl }),
  Schema.TaggedStruct("TopLevel", { ttl: PromptCacheTtl }),
  Schema.TaggedStruct("Off", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type PromptCacheSettings = typeof PromptCacheSettings.Type

/** A supported wire control; an omitted lifetime means five minutes. */
export const PromptCacheControl = Schema.Struct({
  type: Schema.Literal("ephemeral"),
  ttl: Schema.optionalKey(PromptCacheTtl),
})
export type PromptCacheControl = typeof PromptCacheControl.Type

/** One actual cacheable wire position, in semantic cache-prefix order. */
export const CachePosition = Schema.Union([
  Schema.TaggedStruct("Unmarked", {}),
  Schema.TaggedStruct("Caller", { control: Schema.Unknown }),
  Schema.TaggedStruct("Auto", { priority: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type CachePosition = typeof CachePosition.Type

/** All eligible positions, including unmarked blocks needed to locate the final target. */
export const BreakpointInput = Schema.Struct({
  positions: Schema.Array(CachePosition),
  policy: PromptCacheSettings,
  capability: Schema.Boolean,
  callerTopLevel: Schema.optionalKey(Schema.Unknown),
})
export type BreakpointInput = typeof BreakpointInput.Type

/** Automatic selections are ascending wire indexes; caller controls remain in place. */
export const BreakpointPlan = Schema.Struct({
  selectedAuto: Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).check(Schema.makeFilter((indexes) => indexes.every((index, offset) => offset === 0 || (indexes[offset - 1] ?? -1) < index) ? true : "automatic indexes must be strictly increasing")),
  topLevel: Schema.OptionFromNullOr(PromptCacheControl),
})
export type BreakpointPlan = typeof BreakpointPlan.Type

/** Why prepared Messages cache controls cannot form a supported request. */
export class PromptCacheError extends Schema.TaggedError<PromptCacheError>()("PromptCacheError", {
  reason: Schema.Literals(["Control", "Capability", "Capacity", "TtlOrder", "TopLevel"]),
  message: Schema.String,
}) {}
