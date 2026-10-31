import { Option, Result, Schema } from "effect"
import { parseModelSelection } from "@xandreed/core"
import type { ModelCallPolicy } from "@xandreed/core"
import { anthropicProfileOf } from "./provider-profile.entity.functions.js"
import { AnthropicEffort, ModelSettings, ModelSettingsError, ModelThinking } from "./model-settings.entity.js"
import type { ModelSettingsMap, ResolvedAnthropicSettings } from "./model-settings.entity.js"

const error = (reason: ModelSettingsError["reason"], message: string) => new ModelSettingsError({ reason, message })
const outputLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const displayed = (thinking: ModelThinking): ModelThinking => ModelThinking.match(thinking, {
  Adaptive: (value) => ({ ...value, display: value.display ?? "summarized" }),
  Budget: (value) => ({ ...value, display: value.display ?? "summarized" }),
  BetweenTools: (value) => value,
  Off: (value) => value,
})

/** Resolve public settings without wire fields; an unknown model requires an explicit output cap. */
export const resolveAnthropicSettings = (selection: string, settings: ModelSettingsMap, policy: Option.Option<ModelCallPolicy>): Result.Result<ResolvedAnthropicSettings, ModelSettingsError> => {
  const parsed = parseModelSelection(selection)
  if (Option.isNone(parsed)) return Result.fail(error("Selection", "the model selection must name a provider and model"))
  const decoded = Schema.decodeUnknownResult(ModelSettings)(Object.hasOwn(settings, selection) ? settings[selection] : {}, { onExcessProperty: "error" })
  if (Result.isFailure(decoded)) return Result.fail(error("Settings", "the per-model settings do not decode; check thinking companions, effort and positive integer limits"))
  const configured = decoded.success
  const profile = anthropicProfileOf(parsed.value.modelId)
  const traits = profile.anthropic
  const limits = { ...profile.limits, ...configured.limits }
  const maximum = Option.orElse(Option.flatMap(policy, (value) => Option.fromNullishOr(value.maxOutputTokens)), () => Option.fromNullishOr(limits.maxOutputTokens))
  if (Option.isNone(maximum)) return Result.fail(error("OutputLimit", "an unknown Messages model needs maxOutputTokens in its call policy or per-model limits"))
  const output = Schema.decodeUnknownResult(outputLimit)(maximum.value)
  if (Result.isFailure(output)) return Result.fail(error("OutputLimit", "maxOutputTokens must be a positive finite integer"))
  const thinking = Option.map(Option.orElse(Option.fromNullishOr(configured.thinking), () => traits?.defaultThinking ?? Option.none()), displayed)
  if (Option.exists(thinking, (value) => traits !== undefined && !traits.modes.includes(value._tag))) return Result.fail(error("Thinking", "the configured thinking mode is not supported by this Messages model"))
  const noEffort = traits?.source === "documented" && profile.efforts.length === 0
  if (noEffort && configured.effort !== undefined) return Result.fail(error("Effort", "this Messages model does not support per-model effort"))
  // Generic call policies historically did not send effort to non-effort legacy models.
  const requestedEffort = noEffort ? Option.none() : Option.orElse(Option.map(policy, (value) => value.effort), () => Option.orElse(Option.fromNullishOr(configured.effort), () => traits?.defaultEffort ?? Option.none()))
  const effort = Option.map(requestedEffort, (value): AnthropicEffort => value === "none" ? "low" : value)
  if (Option.exists(effort, (value) => !Schema.is(AnthropicEffort)(value) || (traits?.source === "documented" && !profile.efforts.includes(value)))) return Result.fail(error("Effort", "the configured effort is not supported by this Messages model"))
  if (Option.exists(thinking, (value) => (value._tag === "Off" || value._tag === "BetweenTools") && Option.exists(traits?.reducedEfforts ?? Option.none(), (allowed) => Option.exists(effort, (level) => !allowed.includes(level))))) return Result.fail(error("Effort", "this reduced-thinking mode requires low, medium or high effort"))
  if (Option.exists(thinking, (value) => value._tag === "Budget" && value.budgetTokens >= output.success)) return Result.fail(error("Budget", "the thinking budget must be less than maxOutputTokens"))
  return Result.succeed({ selection, thinking, effort, maxOutputTokens: output.success, ...(Object.keys(limits).length === 0 ? {} : { limits }) })
}

/** Validate request-dependent controls after resolution, before any network I/O. */
export const validateAnthropicRequest = (settings: ResolvedAnthropicSettings, request: { readonly forcedTool: boolean; readonly binding: boolean }): Result.Result<void, ModelSettingsError> => {
  const parsed = parseModelSelection(settings.selection)
  if (Option.isNone(parsed)) return Result.fail(error("Selection", "the model selection must name a provider and model"))
  const profile = anthropicProfileOf(parsed.value.modelId)
  if (request.forcedTool && (Option.contains(profile.anthropic?.forcedTools ?? Option.none(), false) || Option.exists(settings.thinking, (value) => value._tag === "Budget"))) return Result.fail(error("ToolChoice", "this Messages model and thinking mode do not support forced tool choice"))
  if (request.binding && (!profile.bindsThinking || !Option.exists(settings.thinking, (value) => value._tag === "Adaptive"))) return Result.fail(error("Binding", "thinking binding requires a supported Messages model with adaptive thinking"))
  return Result.succeed(undefined)
}
