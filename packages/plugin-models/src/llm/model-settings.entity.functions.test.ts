import { describe, expect, test } from "bun:test"
import { Option, Result, Schema } from "effect"
import type { ModelCallPolicy, ReasoningEffortType } from "@xandreed/core"
import { ModelCallPolicy as ModelCallPolicySchema } from "@xandreed/core"
import { ModelSettings, ModelSettingsMap, ModelThinking, ResolvedAnthropicSettings } from "./model-settings.entity.js"
import type { ModelSettings as Settings } from "./model-settings.entity.js"
import { resolveAnthropicSettings, validateAnthropicRequest } from "./model-settings.entity.functions.js"
import { anthropicProfileOf } from "./provider-profile.entity.functions.js"

const selection = (model: string) => `gateway:${model}`
const resolve = (model: string, settings: Settings = {}, policy: Option.Option<ModelCallPolicy> = Option.none()) => resolveAnthropicSettings(selection(model), { [selection(model)]: settings }, policy)
const value = <A, E extends { readonly message: string }>(result: Result.Result<A, E>): A => Result.getOrThrowWith(result, (error) => new Error(error.message))
const reason = <A>(result: Result.Result<A, { readonly reason: string }>) => Result.isFailure(result) ? result.failure.reason : "accepted"

const featured = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const
const efforts: ReadonlyArray<ReasoningEffortType> = ["none", "low", "medium", "high", "xhigh", "max"]
const modes: ReadonlyArray<ModelThinking> = [{ _tag: "Adaptive" }, { _tag: "Budget", budgetTokens: 1024 }, { _tag: "BetweenTools" }, { _tag: "Off" }]

describe("Messages settings resolve documented native controls", () => {
  test("every featured model x thinking mode x effort follows the supported table", () => {
    featured.forEach((model) => modes.forEach((thinking) => efforts.forEach((effort) => {
      const reducedEffort = effort !== "xhigh" && effort !== "max"
      const allowed = thinking._tag === "Adaptive" || (thinking._tag === "BetweenTools" && model === "claude-sonnet-5-5" && reducedEffort)
        || (thinking._tag === "Off" && model === "claude-haiku-5-5" && reducedEffort)
      const result = resolve(model, { thinking, effort })
      expect({ model, thinking: thinking._tag, effort, accepted: Result.isSuccess(result) }).toEqual({ model, thinking: thinking._tag, effort, accepted: allowed })
    })))
  })

  test("defaults are adaptive summarized with model-specific native effort and documented output caps", () => {
    expect(featured.map((model) => value(resolve(model)))).toEqual(featured.map((model) => ({
      selection: selection(model), thinking: Option.some({ _tag: "Adaptive", display: "summarized" }),
      effort: Option.some(model === "claude-opus-5-5" || model === "claude-haiku-5-5" ? "medium" : "high"),
      maxOutputTokens: 128_000, limits: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    })))
  })

  test("call policy beats settings beats profile independently for output and native effort", () => {
    const settings: Settings = { effort: "xhigh", limits: { contextWindow: 200_000, maxOutputTokens: 8192 } }
    const overridden = value(resolve("claude-fable-5-1", settings, Option.some({ effort: "max", maxOutputTokens: 4096 })))
    expect([overridden.maxOutputTokens, overridden.effort, overridden.limits]).toEqual([4096, Option.some("max"), { contextWindow: 200_000, maxOutputTokens: 8192 }])
    const withoutOutput = value(resolve("claude-fable-5-1", settings, Option.some({ effort: "none" })))
    expect([withoutOutput.maxOutputTokens, withoutOutput.effort]).toEqual([8192, Option.some("low")])
    expect(value(resolve("claude-fable-5-1", settings)).effort).toEqual(Option.some("xhigh"))
    expect(value(resolve("claude-fable-5-1", { limits: { maxOutputTokens: 1024 } })).limits).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 1024 })
  })

  test("display omission is a framework summarized default and explicit omitted survives", () => {
    expect(value(resolve("claude-fable-5-1", { thinking: { _tag: "Adaptive", display: "omitted" } })).thinking).toEqual(Option.some({ _tag: "Adaptive", display: "omitted" }))
    expect(value(resolve("claude-haiku-4-5", { thinking: { _tag: "Budget", budgetTokens: 1024 } })).thinking).toEqual(Option.some({ _tag: "Budget", budgetTokens: 1024, display: "summarized" }))
    expect(Schema.decodeUnknownOption(ModelThinking)({ _tag: "Off", display: "summarized" }, { onExcessProperty: "error" })).toEqual(Option.none())
    expect(Schema.decodeUnknownOption(ModelThinking)({ _tag: "BetweenTools", display: "omitted" }, { onExcessProperty: "error" })).toEqual(Option.none())
    expect(Schema.decodeUnknownOption(ModelThinking)({ _tag: "BetweenTools", budgetTokens: 1024 }, { onExcessProperty: "error" })).toEqual(Option.none())
  })

  test("dated IDs use their profile; future Fable policy is labelled and invents no token limits", () => {
    expect(value(resolve("claude-opus-5-5-20261001")).effort).toEqual(Option.some("medium"))
    const future = anthropicProfileOf("claude-fable-5-9")
    expect(future.anthropic?.source).toBe("family-policy")
    expect(future.limits).toBeUndefined()
    expect(reason(resolve("claude-fable-5-9"))).toBe("OutputLimit")
    expect(reason(resolve("claude-fable-5-9", { thinking: { _tag: "Off" }, limits: { maxOutputTokens: 4096 } }))).toBe("Thinking")
    expect(value(resolve("claude-fable-5-9", { limits: { maxOutputTokens: 4096 } })).thinking).toEqual(Option.some({ _tag: "Adaptive", display: "summarized" }))
  })

  test("unknown aliases need an explicit output cap and do not acquire guessed thinking or catalog limits", () => {
    expect(anthropicProfileOf("deployment-alias")).toEqual({ id: "deployment-alias", images: true, efforts: [], bindsThinking: false })
    expect(reason(resolve("deployment-alias"))).toBe("OutputLimit")
    expect(value(resolve("deployment-alias", {}, Option.some({ effort: "low", maxOutputTokens: 4096 })))).toEqual({ selection: selection("deployment-alias"), thinking: Option.none(), effort: Option.some("low"), maxOutputTokens: 4096 })
    expect(value(resolve("deployment-alias", { limits: { maxOutputTokens: 2048 } })).thinking).toEqual(Option.none())
    expect(value(resolve("deployment-alias", { thinking: { _tag: "Adaptive" }, effort: "max", limits: { maxOutputTokens: 2048 } })).thinking).toEqual(Option.some({ _tag: "Adaptive", display: "summarized" }))
  })

  test("full provider:model keys isolate gateways serving the same native model ID", () => {
    const configured = { "one:claude-opus-5-5": { effort: "max" as const, limits: { maxOutputTokens: 1024 } } }
    expect(value(resolveAnthropicSettings("one:claude-opus-5-5", configured, Option.none())).maxOutputTokens).toBe(1024)
    expect(value(resolveAnthropicSettings("two:claude-opus-5-5", configured, Option.none())).maxOutputTokens).toBe(128_000)
    expect(reason(resolveAnthropicSettings("no-provider", {}, Option.none()))).toBe("Selection")
    expect(Schema.decodeUnknownOption(ModelSettingsMap)({ "no-provider": {} })).toEqual(Option.none())
  })

  test("legacy defaults/caps remain documented; generic effort is ignored only for a non-effort legacy model", () => {
    expect(value(resolve("claude-opus-4-8")).thinking).toEqual(Option.some({ _tag: "Off" }))
    expect(value(resolve("claude-sonnet-5")).thinking).toEqual(Option.some({ _tag: "Adaptive", display: "summarized" }))
    const haiku = value(resolve("claude-haiku-4-5", {}, Option.some({ effort: "max" })))
    expect(haiku.thinking).toEqual(Option.some({ _tag: "Off" }))
    expect(haiku.effort).toEqual(Option.none())
    expect(haiku.maxOutputTokens).toBe(64_000)
    expect(reason(resolve("claude-haiku-4-5", { effort: "low" }))).toBe("Effort")
    expect(reason(resolve("claude-opus-4-6", { effort: "xhigh" }))).toBe("Effort")
  })

  test("legacy manual budgets require at least1024 and strictly less than the effective output cap", () => {
    expect(Schema.decodeUnknownOption(ModelSettings)({ thinking: { _tag: "Budget", budgetTokens: 1023 } })).toEqual(Option.none())
    expect(reason(resolve("claude-haiku-4-5", { thinking: { _tag: "Budget", budgetTokens: 1024 }, limits: { maxOutputTokens: 1024 } }))).toBe("Budget")
    expect(reason(resolve("claude-haiku-4-5", { thinking: { _tag: "Budget", budgetTokens: 1024 }, limits: { maxOutputTokens: 1025 } }))).toBe("accepted")
    expect(reason(resolve("claude-opus-4-8", { thinking: { _tag: "Budget", budgetTokens: 1024 } }))).toBe("Thinking")
  })

  test("resolved caps reject nonpositive, fractional and nonfinite call-policy numbers without tightening stored policy", () => {
    expect([0, -1, 1.5, NaN, Infinity].map((maxOutputTokens) => reason(resolve("claude-fable-5-1", {}, Option.some({ effort: "high", maxOutputTokens }))))).toEqual(Array.from({ length: 5 }, () => "OutputLimit"))
    expect(Schema.is(ResolvedAnthropicSettings)(value(resolve("claude-fable-5-1")))).toBe(true)
    expect(Schema.is(ModelCallPolicySchema)({ effort: "high", maxOutputTokens: -1 })).toBe(true)
  })

  test("invalid per-model companions and bounds remain typed settings failures at a direct reference edge", () => {
    expect(reason(resolve("claude-fable-5-1", { thinking: { _tag: "Off", display: "summarized" } } as never))).toBe("Settings")
    expect(reason(resolve("claude-fable-5-1", { limits: { maxOutputTokens: 0 } } as never))).toBe("Settings")
    expect(reason(resolveAnthropicSettings("gateway:claude-fable-5-1", { "gateway:claude-fable-5-1": undefined } as never, Option.none()))).toBe("Settings")
  })

  test("forced tools follow exact native exceptions while manual budgets reject forced choice", () => {
    expect(featured.map((model) => reason(validateAnthropicRequest(value(resolve(model)), { forcedTool: true, binding: false })))).toEqual(["ToolChoice", "ToolChoice", "ToolChoice", "accepted"])
    expect(reason(validateAnthropicRequest(value(resolve("claude-fable-5")), { forcedTool: true, binding: false }))).toBe("accepted")
    expect(reason(validateAnthropicRequest(value(resolve("claude-haiku-4-5", { thinking: { _tag: "Budget", budgetTokens: 1024 } })), { forcedTool: true, binding: false }))).toBe("ToolChoice")
  })

  test("actual binding requires adaptive; reduced modes remain valid when the builder omits binding", () => {
    const off = value(resolve("claude-haiku-5-5", { thinking: { _tag: "Off" } }))
    const between = value(resolve("claude-sonnet-5-5", { thinking: { _tag: "BetweenTools" } }))
    expect([off, between].map((settings) => reason(validateAnthropicRequest(settings, { forcedTool: false, binding: false })))).toEqual(["accepted", "accepted"])
    expect([off, between].map((settings) => reason(validateAnthropicRequest(settings, { forcedTool: false, binding: true })))).toEqual(["Binding", "Binding"])
    expect(reason(validateAnthropicRequest(value(resolve("claude-fable-5-1")), { forcedTool: false, binding: true }))).toBe("accepted")
  })
})
