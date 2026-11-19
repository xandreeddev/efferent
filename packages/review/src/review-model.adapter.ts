import type { Layer, Redacted } from "effect"
import type { LanguageModel } from "effect/ai"
import type { ModelSpend } from "@xandreed/core"
import { openAiCompatibleModel } from "@xandreed/sdk/node"
import type { ReviewModel } from "./review-model.entity.js"

/**
 * The review's model as the kernel's `openAiCompatibleModel`: each call charges the `ModelSpend` ledger in context,
 * its worst case held before it is sent under the review's total cap (`maxCost`), and settled at what the provider
 * billed.
 */
export const reviewModel = (model: ReviewModel, apiKey: Redacted.Redacted<string>, maxCost: number): Layer.Layer<LanguageModel.LanguageModel, never, ModelSpend> =>
  openAiCompatibleModel({
    model: model.model,
    baseUrl: model.baseUrl,
    apiKey,
    maxOutputTokens: model.maxOutputTokens,
    extra: model.extra,
    provider: model.provider,
    spend: { prices: { [model.model]: model.price }, caps: { total: maxCost }, bytesPerToken: model.bytesPerToken },
  })
