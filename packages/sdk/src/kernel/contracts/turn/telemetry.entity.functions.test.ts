import { describe, expect, test } from "bun:test"
import { Effect, Metric, Option } from "effect"
import { toolCalls } from "./telemetry.entity.js"
import { countTool } from "./telemetry.entity.functions.js"

describe("the tool calls' count", () => {
  test("a call is counted by its tool's name, or unknown for one the toolkit has not, and whether its result is a failure", async () => {
    const values = await Effect.runPromise(Effect.gen(function* () {
      yield* countTool(Option.some("add"), false)
      yield* countTool(Option.some("add"), false)
      yield* countTool(Option.none(), true)
      const of = (attributes: Record<string, string>) => Effect.map(Metric.value(Metric.withAttributes(toolCalls, attributes)), (state) => state.count)
      return [
        yield* of({ "efferent.tool": "add", "efferent.outcome": "succeeded" }),
        yield* of({ "efferent.tool": "unknown", "efferent.outcome": "failed" }),
      ]
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))
    expect(values).toEqual([2, 1])
  })
})
