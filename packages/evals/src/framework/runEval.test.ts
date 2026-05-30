import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { defineEval } from "./Eval.js"
import { runEval } from "./runEval.js"
import { includesAll, predicate } from "./scorers.js"

// A self-contained eval (R = never) so it runs with no layer / no LLM.
const echo = defineEval<string, string, { needles: ReadonlyArray<string> }, never>({
  name: "echo",
  data: [
    { name: "hit", input: "hello world", expected: { needles: ["hello", "world"] } },
    { name: "partial", input: "hello", expected: { needles: ["hello", "world"] } },
  ],
  task: (input) => Effect.succeed(input),
  scorers: [
    predicate("nonempty", ({ output }) => output.length > 0),
    includesAll("covers", ({ output, expected }) => ({ haystack: output, needles: expected.needles })),
  ],
})

describe("runEval", () => {
  test("scores cases and computes a passing mean", async () => {
    const report = await Effect.runPromise(runEval(echo))
    expect(report.name).toBe("echo")
    expect(report.cases).toHaveLength(2)

    const hit = report.cases.find((c) => c.name === "hit")!
    expect(hit.ok).toBe(true)
    expect(hit.mean).toBe(1) // nonempty=1, covers=1

    const partial = report.cases.find((c) => c.name === "partial")!
    expect(partial.scores.find((s) => s.name === "covers")!.score).toBe(0.5) // 1 of 2 needles
    expect(partial.mean).toBeCloseTo(0.75) // (1 + 0.5) / 2

    expect(report.mean).toBeCloseTo((1 + 0.75) / 2)
    expect(report.passed).toBe(true) // default threshold 0.6
  })

  test("a throwing task is captured as a 0-scored case, not a crash", async () => {
    const boom = defineEval<number, number, null, never>({
      name: "boom",
      data: [{ name: "explodes", input: 1, expected: null }],
      task: () => Effect.die(new Error("kaboom")),
      scorers: [predicate("always", () => true)],
    })
    const report = await Effect.runPromise(runEval(boom))
    expect(report.cases[0]!.ok).toBe(false)
    expect(report.cases[0]!.error).toContain("kaboom")
    expect(report.cases[0]!.mean).toBe(0)
    expect(report.passed).toBe(false)
  })

  test("a failing scorer scores 0 without sinking the case", async () => {
    const spec = defineEval<string, string, null, never>({
      name: "scorer-fail",
      data: [{ name: "c", input: "x", expected: null }],
      task: (i) => Effect.succeed(i),
      scorers: [
        predicate("ok", () => true),
        { name: "throws", score: () => Effect.die(new Error("scorer boom")) },
      ],
    })
    const report = await Effect.runPromise(runEval(spec))
    const c = report.cases[0]!
    expect(c.ok).toBe(true)
    expect(c.scores.find((s) => s.name === "ok")!.score).toBe(1)
    expect(c.scores.find((s) => s.name === "throws")!.score).toBe(0)
    expect(c.mean).toBe(0.5)
  })
})
