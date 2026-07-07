import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { defineEval } from "./Eval.js"
import { fromEffect } from "./scorers.js"
import { runEval } from "./runEval.js"

describe("runEval — N-sample aggregation (statistical rigor)", () => {
  it("runs each case `samples` times and reports mean ± sample-stdev over one case", () => {
    // A deterministic 'noisy' task: three samples yield 0, 0.5, 1.
    let call = 0
    const spec = defineEval<null, number, null, never>({
      name: "samples-test",
      samples: 3,
      data: [{ name: "noisy", input: null, expected: null }],
      task: () => Effect.sync(() => [0, 0.5, 1][call++ % 3] ?? 0),
      threshold: 0.6,
      scorers: [fromEffect("score", ({ output }) => Effect.succeed(output))],
    })

    const report = Effect.runSync(runEval(spec))
    const c = report.cases[0]!
    expect(c.samples).toBe(3)
    expect(c.mean).toBeCloseTo(0.5) // (0 + 0.5 + 1) / 3
    expect(c.stdev).toBeCloseTo(0.5) // sample stdev of [0, 0.5, 1]
    expect(c.ok).toBe(true)
    // The per-scorer score is the mean across samples too.
    expect(c.scores[0]!.score).toBeCloseTo(0.5)
  })

  it("defaults to 1 sample with zero variance (unchanged behaviour)", () => {
    const spec = defineEval<null, number, null, never>({
      name: "single",
      data: [{ name: "c", input: null, expected: null }],
      task: () => Effect.succeed(1),
      threshold: 0.6,
      scorers: [fromEffect("score", ({ output }) => Effect.succeed(output))],
    })
    const c = Effect.runSync(runEval(spec)).cases[0]!
    expect(c.samples).toBe(1)
    expect(c.stdev).toBe(0)
    expect(c.mean).toBe(1)
  })

  it("a sample whose task fails is a 0-scored sample, dragging the mean (not a crash)", () => {
    let call = 0
    const spec = defineEval<null, number, null, never>({
      name: "one-fails",
      samples: 2,
      data: [{ name: "c", input: null, expected: null }],
      // First sample succeeds at 1.0, second throws → counts as 0.
      task: () => (call++ === 0 ? Effect.succeed(1) : Effect.fail("boom")),
      threshold: 0.6,
      scorers: [fromEffect("score", ({ output }) => Effect.succeed(output))],
    })
    const c = Effect.runSync(runEval(spec)).cases[0]!
    expect(c.samples).toBe(2)
    expect(c.mean).toBeCloseTo(0.5) // (1 + 0) / 2
    expect(c.ok).toBe(true) // at least one sample produced a result
  })
})
