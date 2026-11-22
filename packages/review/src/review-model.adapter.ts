import type { Layer, Redacted } from "effect"
import type { LanguageModel } from "effect/ai"
import type { ModelSpend } from "@xandreed/core"
import { anthropicModel, openAiCompatibleModel } from "@xandreed/sdk/node"
import type { ReviewModel } from "./review-model.entity.js"

/**
 * The review's model as the kernel's provider for its wire, `openAiCompatibleModel` (chat) or `anthropicModel`
 * (Messages, at the model's `effort` as adaptive thinking; `default` and `none` send no thinking): each call charges the
 * `ModelSpend` ledger in context, its worst case held before it is sent under the review's total cap (`maxCost`), and
 * settled at what the provider billed, else at its usage at the price.
 */
export const reviewModel = (model: ReviewModel, apiKey: Redacted.Redacted<string>, maxCost: number): Layer.Layer<LanguageModel.LanguageModel, never, ModelSpend> => {
  const spend = { prices: { [model.model]: model.price }, caps: { total: maxCost }, bytesPerToken: model.bytesPerToken }
  if (model.wire === "messages") {
    const effort = model.effort === "default" || model.effort === "none" ? {} : { effort: model.effort }
    return anthropicModel({ model: model.model, apiKey, baseUrl: model.baseUrl, maxOutputTokens: model.maxOutputTokens, spend, ...effort })
  }
  return openAiCompatibleModel({
    model: model.model,
    baseUrl: model.baseUrl,
    apiKey,
    maxOutputTokens: model.maxOutputTokens,
    extra: model.extra,
    provider: model.provider,
    spend,
  })
}
