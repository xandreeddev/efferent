import { Context, type Effect, type Stream } from "effect"
import type { LlmError, LlmGenerateInput } from "./Llm.js"

/**
 * Simple text-in-text-out LLM, intended for non-loop calls that don't need
 * tools, multi-turn reasoning, or provider-side caching: second-pass UI
 * rendering, extraction, summarisation, eventual compaction, etc.
 *
 * Backed by a deliberately cheaper / faster model than `Llm` (e.g.
 * `gemini-3.5-flash-lite` vs `gemini-3.5-flash`). Reuses `LlmGenerateInput`
 * and `LlmError` from `Llm.ts` so call sites don't carry two error types.
 */
export class LlmFast extends Context.Tag("@agent/core/LlmFast")<
  LlmFast,
  {
    readonly generate: (
      input: LlmGenerateInput,
    ) => Effect.Effect<string, LlmError>
    readonly streamGenerate: (
      input: LlmGenerateInput,
    ) => Stream.Stream<string, LlmError>
  }
>() {}
