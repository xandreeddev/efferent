import type { LanguageModel } from "@effect/ai"
import type { Effect } from "effect"
import { makeOpenAiCompatLanguageModel } from "./openAiCompat.js"

/**
 * z.ai (Zhipu AI's international platform) hosts the GLM family behind an
 * OpenAI-compatible `/chat/completions` endpoint at `…/api/paas/v4`. The
 * "GLM Coding Plan" subscription and a pay-as-you-go key authenticate the
 * same way — a Bearer API key — so there's no OAuth flow; `:login` stores it
 * as an ordinary `api_key` credential. GLM ids route through the shared
 * OpenAI-compatible client's `reasoning_effort` thinking knob.
 */
export const ZAI_API_URL = "https://api.z.ai/api/paas/v4"
export const ZAI_CHAT_URL = `${ZAI_API_URL}/chat/completions`
export const ZAI_MODELS_URL = `${ZAI_API_URL}/models`

export const makeZaiLanguageModel = (
  model: string,
  apiKey: string,
  thinkingMode?: "off" | "high",
): Effect.Effect<LanguageModel.Service> =>
  makeOpenAiCompatLanguageModel({
    moduleName: "Zai",
    chatUrl: ZAI_CHAT_URL,
    apiKey,
    model,
    thinkingMode,
  })
