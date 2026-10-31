import { Option, Schema } from "effect"
import { ModelFailureKind } from "./model-failure.entity.js"
import { ModelSelection } from "./model-selection.entity.js"
import { RunId, RunOrdinal } from "./run.entity.js"
import { TokenUsage } from "./token-usage.entity.js"

/** One logical model call; physical retries share its id and count attempts. @public */
export const ModelCallId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("ModelCallId"))
export type ModelCallId = typeof ModelCallId.Type

/** @public */
export const ModelCallPurpose = Schema.Literals(["Loop", "Helper"])
export type ModelCallPurpose = typeof ModelCallPurpose.Type
/** @public */
export const ModelCallMethod = Schema.Literals(["Text", "Object", "Stream"])
export type ModelCallMethod = typeof ModelCallMethod.Type

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ObservedUsage = Schema.Struct({
  inputTokens: Count, outputTokens: Count, totalTokens: Count,
  cacheReadTokens: Count, cacheWriteTokens: Count, reasoningTokens: Count,
}).check(Schema.makeFilter((usage) => usage.totalTokens === usage.inputTokens + usage.outputTokens
  && usage.cacheReadTokens + usage.cacheWriteTokens <= usage.inputTokens
  && usage.reasoningTokens <= usage.outputTokens ? true : "model call usage must hold the normalized token-count invariants"))
const ReportedField = Schema.Literals(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"])
const ReportedFields = Schema.Array(ReportedField).check(Schema.makeFilter((fields) => fields.length > 0 && new Set(fields).size === fields.length
  ? true : "partial usage must name distinct reported fields"))

/** Reported usage, distinct from unknown usage and from nonfinal subtotals. @public */
export const ModelCallUsage = Schema.Union([
  Schema.TaggedStruct("Unknown", {}),
  Schema.TaggedStruct("Known", { usage: ObservedUsage }),
  Schema.TaggedStruct("Partial", { usage: ObservedUsage, reported: ReportedFields }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ModelCallUsage = typeof ModelCallUsage.Type

/** Provider outcome before downstream response acceptance; independent of usage. @public */
export const ModelCallOutcome = Schema.Union([
  Schema.TaggedStruct("Completed", {}),
  Schema.TaggedStruct("Failed", { failure: Schema.OptionFromNullOr(ModelFailureKind) }),
  Schema.TaggedStruct("Interrupted", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ModelCallOutcome = typeof ModelCallOutcome.Type

/** Metadata for one terminal physical attempt; no prompts or credential-bearing settings. @public */
export const ModelCallData = Schema.Struct({
  callId: ModelCallId,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  purpose: ModelCallPurpose,
  method: ModelCallMethod,
  model: Schema.OptionFromNullOr(ModelSelection),
  runId: Schema.OptionFromNullOr(RunId),
  run: Schema.OptionFromNullOr(RunOrdinal),
  step: Schema.OptionFromNullOr(Count),
  durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  usage: ModelCallUsage,
  outcome: ModelCallOutcome,
}).check(Schema.makeFilter((call) => Option.isSome(call.runId) === Option.isSome(call.run)
  && (Option.isNone(call.step) || Option.isSome(call.run)) ? true : "model call run and step correlation must agree"))
export type ModelCallData = typeof ModelCallData.Type

/** Selected-response fallback facts for a turn without any model-call ledger. @public */
export const ModelCallLegacyUsage = Schema.Struct({
  model: Schema.OptionFromNullOr(Schema.String),
  usage: TokenUsage,
  /** Already durable before the observing TurnLive was built. */
  replayed: Schema.Boolean,
})
export type ModelCallLegacyUsage = typeof ModelCallLegacyUsage.Type
