import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { describe, expect, test } from "bun:test"
import { processSpans } from "./process.js"

/** Minimal `ReadableSpan` stand-in carrying only what `processSpans` reads. */
const mkSpan = (
  name: string,
  id: string,
  parent: string | undefined,
  attributes: Record<string, string | number | boolean>,
  durationMs = 1,
): ReadableSpan =>
  ({
    name,
    spanContext: () => ({ spanId: id, traceId: "trace", traceFlags: 1 }),
    parentSpanContext:
      parent !== undefined ? { spanId: parent, traceId: "trace", traceFlags: 1 } : undefined,
    attributes,
    duration: [0, durationMs * 1e6],
  }) as unknown as ReadableSpan

describe("processSpans", () => {
  test("aggregates a case subtree into scores, steps, tokens, and config", () => {
    const spans = [
      mkSpan("eval.run", "run", undefined, { "config.name": "baseline" }),
      mkSpan("eval.suite", "suite", "run", { "eval.suite": "whole-task" }),
      mkSpan(
        "eval.case",
        "case",
        "suite",
        {
          "eval.suite": "whole-task",
          "eval.case": "bug-fix",
          "eval.mean": 0.8,
          "eval.ok": true,
          "eval.score.expectations_met": 1,
          "eval.score.coverage": 0.6,
        },
        1500,
      ),
      mkSpan("agent.turn", "t1", "case", {}),
      mkSpan("agent.turn", "t2", "t1", {}),
      mkSpan("llm.generate", "l1", "t1", {
        "gen_ai.system": "google",
        "gen_ai.request.model": "gemini-3.5-flash",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20,
        "gen_ai.usage.cache_read_tokens": 0,
      }),
    ]

    const runs = processSpans(spans)
    expect(runs.length).toBe(1)
    const run = runs[0]!
    expect(run.configName).toBe("baseline")

    const suite = run.suites[0]!
    expect(suite.suite).toBe("whole-task")
    expect(suite.mean).toBeCloseTo(0.8)
    expect(suite.passRate).toBe(1)

    const c = suite.cases[0]!
    expect(c.steps).toBe(2)
    expect(c.inputTokens).toBe(100)
    expect(c.outputTokens).toBe(20)
    expect(c.wallMs).toBe(1500)
    expect(c.scores.map((s) => s.name).sort()).toEqual(["coverage", "expectations_met"])
  })

  test("groups cases by config and defaults config name when no eval.run", () => {
    const spans = [
      mkSpan("eval.case", "c1", undefined, {
        "eval.suite": "judge-approval",
        "eval.case": "x",
        "eval.mean": 0.4,
        "eval.ok": true,
      }),
    ]
    const runs = processSpans(spans)
    expect(runs[0]!.configName).toBe("default")
    expect(runs[0]!.suites[0]!.mean).toBeCloseTo(0.4)
    expect(runs[0]!.suites[0]!.passRate).toBe(0)
  })
})
