import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { Config, Effect, Layer, Redacted } from "effect"
import { LlmFast } from "@agent/core"
import { buildLlm } from "./vercelAi.js"

/**
 * Fast / cheap tier LLM. Same provider as `LlmLive`, different model id
 * and no cache plumbing — used for non-loop calls (renderUi, capture, and
 * eventually compaction / session titles).
 *
 * `buildLlm` returns the full `Llm` service shape; we only expose the
 * two simple methods through the `LlmFast` tag.
 */
export const GeminiFastLive = Layer.effect(
  LlmFast,
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("GOOGLE_GENERATIVE_AI_API_KEY")
    const modelName = yield* Config.string("AGENT_FAST_MODEL").pipe(
      Config.withDefault("gemini-3.5-flash-lite"),
    )
    const provider = createGoogleGenerativeAI({ apiKey: Redacted.value(apiKey) })
    const full = buildLlm(provider(modelName), { modelIdOverride: modelName })
    return LlmFast.of({
      generate: full.generate,
      streamGenerate: full.streamGenerate,
    })
  }),
)
