import { describe, expect, test } from "bun:test"
import { Effect, Exit, Metric, Option } from "effect"
import { ModelAnswerFailed } from "./model-answer.entity.js"
import { AnswerCut } from "./planned.entity.js"
import { modelCalls, modelTokens, toolCalls } from "./telemetry.entity.js"
import { answerOutcomeOf, countAnswer, countTool, tokensOf } from "./telemetry.entity.functions.js"

describe("the kernel's metrics of its work", () => {
  test("a model call's outcome, from the exit of its reading", () => {
    expect([
      Exit.succeed("an answer"),
      Exit.fail(new ModelAnswerFailed({ message: "overloaded", cause: "overloaded" })),
      Exit.fail(new AnswerCut({ message: "lost", cause: "lost" })),
      Exit.fail(new Error("the reader's own failure")),
      Exit.interrupt(1),
      Exit.die("a defect"),
    ].map(answerOutcomeOf)).toEqual(["answered", "failed", "cut", "failed", "interrupted", "failed"])
  })

  test("a usage's tokens by kind, apart, so they sum to its input and output; the cache's reads only when counted", () => {
    expect(tokensOf({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 })).toEqual([["input", 60], ["cache_read", 40], ["output", 10]])
    expect(tokensOf({ inputTokens: 100, outputTokens: 10 })).toEqual([["input", 100], ["output", 10]])
  })

  test("a call is counted by the model that answered and how it ended; one no stream named is unknown; a tool by its name or unknown", async () => {
    const values = await Effect.runPromise(Effect.gen(function* () {
      yield* countAnswer(Option.some("m"), "answered", Option.some({ inputTokens: 5, outputTokens: 2 }))
      yield* countAnswer(Option.some("m"), "answered", Option.none())
      yield* countAnswer(Option.none(), "failed", Option.none())
      yield* countTool(Option.some("add"), false)
      yield* countTool(Option.none(), true)
      const of = (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) => Effect.map(Metric.value(Metric.withAttributes(metric, attributes)), (state) => state.count)
      return [
        yield* of(modelCalls, { "efferent.model": "m", "efferent.outcome": "answered" }),
        yield* of(modelCalls, { "efferent.model": "unknown", "efferent.outcome": "failed" }),
        yield* of(modelTokens, { "efferent.model": "m", "efferent.token.kind": "input" }),
        yield* of(modelTokens, { "efferent.model": "m", "efferent.token.kind": "output" }),
        yield* of(toolCalls, { "efferent.tool": "add", "efferent.outcome": "succeeded" }),
        yield* of(toolCalls, { "efferent.tool": "unknown", "efferent.outcome": "failed" }),
      ]
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))
    expect(values).toEqual([2, 1, 5, 2, 1, 1])
  })
})
