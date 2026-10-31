import { Option, Schema } from "effect"
import { ModelLimits, ReasoningEffort, parseModelSelection } from "@xandreed/core"
import { PromptCacheSettings } from "./prompt-cache.entity.js"

/** The public reasoning summary returned with adaptive or manual thinking. @public */
export const ThinkingDisplay = Schema.Literals(["summarized", "omitted"])
export type ThinkingDisplay = typeof ThinkingDisplay.Type

/** Model-specific thinking controls; modes carry only their supported companions. @public */
export const ModelThinking = Schema.Union([
  Schema.TaggedStruct("Adaptive", { display: Schema.optionalKey(ThinkingDisplay) }),
  Schema.TaggedStruct("Budget", { budgetTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1024)), display: Schema.optionalKey(ThinkingDisplay) }),
  Schema.TaggedStruct("BetweenTools", {}),
  Schema.TaggedStruct("Off", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ModelThinking = typeof ModelThinking.Type

/** Static host settings for one full provider:model selection. @public */
export const ModelSettings = Schema.Struct({
  thinking: Schema.optionalKey(ModelThinking),
  effort: Schema.optionalKey(ReasoningEffort),
  limits: Schema.optionalKey(ModelLimits),
  promptCache: Schema.optionalKey(PromptCacheSettings),
})
export type ModelSettings = typeof ModelSettings.Type

/** Settings keyed by the complete provider:modelId selection, including gateway aliases. @public */
export const ModelSettingsMap = Schema.Record(Schema.String, ModelSettings).check(Schema.makeFilter((settings) => Object.keys(settings).every((selection) => Option.isSome(parseModelSelection(selection))) ? true : "keys must be full provider:modelId selections"))
export type ModelSettingsMap = typeof ModelSettingsMap.Type

/** Why configured model controls cannot form a valid Messages request. @public */
export class ModelSettingsError extends Schema.TaggedError<ModelSettingsError>()("ModelSettingsError", {
  reason: Schema.Literals(["Settings", "Selection", "OutputLimit", "Thinking", "Effort", "Budget", "ToolChoice", "Binding"]),
  message: Schema.String,
}) {}

/** Anthropic's native vocabulary; neutral none is mapped to low by local adapter policy. */
export const AnthropicEffort = ReasoningEffort.pick(["low", "medium", "high", "xhigh", "max"])
export type AnthropicEffort = typeof AnthropicEffort.Type

/** Effective public request settings; unknown thinking/effort remains absent. */
export const ResolvedAnthropicSettings = Schema.Struct({
  selection: Schema.String,
  thinking: Schema.OptionFromNullOr(ModelThinking),
  effort: Schema.OptionFromNullOr(AnthropicEffort),
  maxOutputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  promptCache: PromptCacheSettings,
  limits: Schema.optionalKey(ModelLimits),
})
export type ResolvedAnthropicSettings = typeof ResolvedAnthropicSettings.Type
