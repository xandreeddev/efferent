import { Effect, Layer, Option, Schema } from "effect"
import { ContextManager, definePlugin, HarnessError, safeKeepFrom, UtilityLlm } from "@xandreed/core"

const Config = Schema.Struct({ thresholdTokens: Schema.Int.pipe(Schema.positive()), keepTurns: Schema.Int.pipe(Schema.positive()) })
export const contextPlugin = definePlugin({
  id: "@xandreed/plugin-context", version: "0.4.0", requires: [UtilityLlm], provides: [ContextManager],
  config: Config, defaults: { thresholdTokens: 80000, keepTurns: 6 },
  layer: (config) => Layer.effect(ContextManager, Effect.gen(function* () {
    const utility = yield* UtilityLlm
    return ContextManager.of({ compact: (messages, tokens) => Effect.gen(function* () {
      if (tokens < config.thresholdTokens) return Option.none()
      const cut = safeKeepFrom(messages, config.keepTurns)
      if (Option.isNone(cut)) return Option.none()
      const digest = yield* utility.complete(`Summarize this agent transcript for continuation. Preserve the user's goal, constraints, modified files, verification results and unresolved work. Do not invent completion.\n${JSON.stringify(messages).slice(-120000)}`).pipe(
        Effect.mapError((error) => new HarnessError({ code: "context.summary", message: String(error) })),
      )
      return digest.text.trim().length === 0 ? Option.none() : Option.some({ summary: digest.text, keepFrom: cut.value })
    }) })
  })),
})
export default contextPlugin
