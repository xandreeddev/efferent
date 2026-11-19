import { Cause, Effect, Exit, Metric, Option, Predicate } from "effect"
import type { Usage } from "@xandreed/core/kernel"
import { MODEL_ATTRIBUTE, modelCalls, modelTokens, OUTCOME_ATTRIBUTE, TOKEN_KIND_ATTRIBUTE, TOOL_ATTRIBUTE, toolCalls, UNKNOWN } from "./telemetry.entity.js"
import type { AnswerOutcome, TokenKind } from "./telemetry.entity.js"

/**
 * How a model call ended, from the exit of its reading: answered, stopped (an interruption alone), cut (an
 * `AnswerCut`: content went on, then the call failed), or failed (anything else, a defect included).
 */
export const answerOutcomeOf = (exit: Exit.Exit<unknown, unknown>): AnswerOutcome => Exit.match(exit, {
  onSuccess: (): AnswerOutcome => "answered",
  onFailure: (cause): AnswerOutcome => Cause.hasInterruptsOnly(cause)
    ? "interrupted"
    : Option.exists(Cause.findErrorOption(cause), (error) => Predicate.isTagged(error, "AnswerCut")) ? "cut" : "failed",
})

/**
 * A call's usage as counts by kind: the input not read from the cache, the cache's reads (when the provider counted
 * them) and the output. The kinds are apart, so their sum is the call's input and output.
 */
export const tokensOf = (usage: Usage): ReadonlyArray<readonly [TokenKind, number]> => {
  const cached = usage.cachedInputTokens ?? 0
  return [
    ["input", Math.max(0, usage.inputTokens - cached)],
    ...(usage.cachedInputTokens === undefined ? [] : [["cache_read", cached] as const]),
    ["output", usage.outputTokens],
  ]
}

/** Count one model call: by the model that answered and how it ended, and the tokens its provider reported. */
export const countAnswer = (model: Option.Option<string>, outcome: AnswerOutcome, usage: Option.Option<Usage>): Effect.Effect<void> => {
  const named = Option.getOrElse(model, () => UNKNOWN)
  return Effect.andThen(
    Metric.update(Metric.withAttributes(modelCalls, { [MODEL_ATTRIBUTE]: named, [OUTCOME_ATTRIBUTE]: outcome }), 1),
    Effect.forEach(Option.match(usage, { onNone: () => [], onSome: tokensOf }), ([kind, count]) =>
      Metric.update(Metric.withAttributes(modelTokens, { [MODEL_ATTRIBUTE]: named, [TOKEN_KIND_ATTRIBUTE]: kind }), count), { concurrency: 1, discard: true }),
  )
}

/** Count one tool call: by the tool it ran (`unknown` for a name the toolkit has not) and whether its result is a failure. */
export const countTool = (tool: Option.Option<string>, failed: boolean): Effect.Effect<void> =>
  Metric.update(Metric.withAttributes(toolCalls, { [TOOL_ATTRIBUTE]: Option.getOrElse(tool, () => UNKNOWN), [OUTCOME_ATTRIBUTE]: failed ? "failed" : "succeeded" }), 1)
