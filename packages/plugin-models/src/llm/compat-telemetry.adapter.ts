import { Effect, Option } from "effect"
import type { Tracer } from "effect"
import { providerUsageCounts } from "./model-usage.entity.functions.js"

/** Annotate the actual native operation, never a routing or engine wrapper. */
export const annotateCompatRequest = (span: Tracer.Span, provider: string, model: string): Effect.Effect<void> => Effect.sync(() => {
  span.attribute("gen_ai.provider.name", provider)
  span.attribute("gen_ai.request.model", model)
  span.attribute("gen_ai.operation.name", "chat")
})

/** Raw cumulative fields replace their own attributes; missing counts never become zero. */
export const observeCompatUsage = (span: Tracer.Span, raw: unknown, final: boolean, reasoning = true): Effect.Effect<void> =>
  Option.match(providerUsageCounts("compat", raw, reasoning), {
    onNone: () => Effect.void,
    onSome: (counts) => Effect.sync(() => {
      const attributes: ReadonlyArray<readonly [string, number | undefined]> = [
        ["gen_ai.usage.input_tokens", counts.inputTokens],
        ["gen_ai.usage.output_tokens", !final && counts.outputTokens === 0 ? undefined : counts.outputTokens],
        ["gen_ai.usage.cache_read.input_tokens", counts.cacheReadTokens],
        ["gen_ai.usage.cache_write.input_tokens", counts.cacheWriteTokens],
        ["gen_ai.usage.reasoning.output_tokens", counts.reasoningTokens],
      ]
      attributes.forEach(([name, value]) => { if (value !== undefined && Number.isSafeInteger(value)) span.attribute(name, value) })
    }),
  })
