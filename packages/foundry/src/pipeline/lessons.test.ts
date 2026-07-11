import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { FactoryRun } from "../domain/FactoryRun.js"
import { deriveLessons, renderLessons } from "./lessons.js"

const run = (args: {
  id: string
  endedAt: number
  attempts: ReadonlyArray<ReadonlyArray<{ rule: string; message: string; fixHint?: string }>>
  accepted?: boolean
}): FactoryRun =>
  Schema.decodeUnknownSync(FactoryRun)({
    id: args.id,
    spec: {
      goal: "toy goal",
      acceptance: ["works"],
      limits: { maxAttempts: 3, budgetMillis: 60_000 },
    },
    attempts: args.attempts.map((findings, i) => ({
      attempt: i + 1,
      report: {
        verdicts:
          findings.length === 0
            ? [{ _tag: "pass", gate: "bun-test", durationMs: 1, findings: [] }]
            : [
                {
                  _tag: "fail",
                  gate: "bun-test",
                  durationMs: 1,
                  findings: findings.map((f) => ({
                    rule: f.rule,
                    severity: "error",
                    message: f.message,
                    ...(f.fixHint !== undefined ? { fixHint: f.fixHint } : {}),
                  })),
                },
              ],
      },
      filesTouched: [],
      durationMs: 5,
    })),
    outcome:
      args.accepted === false
        ? { _tag: "rejected", reason: "attempts-exhausted" }
        : { _tag: "accepted", attempt: args.attempts.length },
    startedAt: args.endedAt - 100,
    endedAt: args.endedAt,
  })

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

describe("deriveLessons — the deterministic memory fold", () => {
  test("a rule recurring across attempts and runs becomes a lesson; latest example wins", () => {
    const lessons = deriveLessons([
      run({
        id: uuid(1),
        endedAt: 100,
        attempts: [
          [{ rule: "test/bun-test", message: "old failure" }],
          [], // accepted on attempt 2
        ],
      }),
      run({
        id: uuid(2),
        endedAt: 200,
        attempts: [
          [{ rule: "test/bun-test", message: "newer failure", fixHint: "run bun test first" }],
          [],
        ],
      }),
    ])
    expect(lessons).toHaveLength(1)
    expect(lessons[0]).toMatchObject({
      rule: "test/bun-test",
      failedAttempts: 2,
      runs: 2,
      lastMessage: "newer failure",
    })
    expect(Option.getOrThrow(lessons[0]!.lastFixHint)).toBe("run bun test first")
  })

  test("one-off failures stay below the threshold; multiple findings in one attempt count once", () => {
    const lessons = deriveLessons([
      run({
        id: uuid(3),
        endedAt: 100,
        attempts: [
          [
            { rule: "effect/no-let", message: "let a" },
            { rule: "effect/no-let", message: "let b" },
            { rule: "test/one-off", message: "once" },
          ],
          [],
        ],
      }),
    ])
    // no-let failed ONE attempt (two findings), one-off one attempt — neither recurs.
    expect(lessons).toHaveLength(0)
  })

  test("ordering: most-recurrent first; cap respected", () => {
    const many = run({
      id: uuid(4),
      endedAt: 100,
      attempts: [
        [
          { rule: "test/rule-a", message: "a" },
          { rule: "test/rule-b", message: "b" },
        ],
        [
          { rule: "test/rule-a", message: "a" },
          { rule: "test/rule-b", message: "b" },
        ],
        [{ rule: "test/rule-a", message: "a" }],
      ],
      accepted: false,
    })
    const lessons = deriveLessons([many], { max: 1 })
    expect(lessons.map((l) => l.rule)).toEqual(["test/rule-a"])
  })
})

describe("renderLessons", () => {
  test("deterministic section; empty renders empty", () => {
    expect(renderLessons([])).toBe("")
    const lessons = deriveLessons([
      run({
        id: uuid(5),
        endedAt: 100,
        attempts: [[{ rule: "test/rule-r", message: "m" }], [{ rule: "test/rule-r", message: "m2" }]],
        accepted: false,
      }),
    ])
    const text = renderLessons(lessons)
    expect(text).toContain("## Lessons from past forge runs")
    expect(text).toContain("[test/rule-r] failed 2 attempt(s) across 1 run(s)")
    expect(text).toContain("m2")
    expect(renderLessons(lessons)).toBe(text)
    // Not an accept check → no promotion hint.
    expect(text).not.toContain("promoting it to a standing check")
  })

  test("a spec check recurring across RUNS carries the promotion hint", () => {
    const failing = [{ rule: "test/accept-lint-clean", message: "eslint exited 1" }]
    const lessons = deriveLessons([
      run({ id: uuid(6), endedAt: 100, attempts: [failing, []], accepted: true }),
      run({ id: uuid(7), endedAt: 200, attempts: [failing, []], accepted: true }),
    ])
    const text = renderLessons(lessons)
    expect(text).toContain("[test/accept-lint-clean]")
    expect(text).toContain("consider promoting it to a standing check in foundry.config.ts")
    // Same rule but seen in ONE run only: recurring within a spec, not across
    // specs — no promotion hint.
    const oneRun = deriveLessons([
      run({ id: uuid(8), endedAt: 100, attempts: [failing, failing], accepted: false }),
    ])
    expect(renderLessons(oneRun)).not.toContain("promoting it to a standing check")
  })
})
