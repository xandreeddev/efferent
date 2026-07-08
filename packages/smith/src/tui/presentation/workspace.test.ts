import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { SpecDoc } from "@xandreed/engine"
import { FactoryRun } from "@xandreed/foundry"
import { runLine, workspaceView } from "./workspace.js"

const doc = (slug: string, status: "draft" | "locked") =>
  Effect.runSync(
    Schema.decodeUnknown(SpecDoc)({
      version: 1,
      slug,
      status,
      created: "2026-07-08T00:00:00Z",
      goal: `the ${slug} goal`,
      acceptance: ["works"],
      constraints: [],
      nonGoals: [],
      checks: [],
      limits: { maxAttempts: 3, budgetMinutes: 15 },
      gates: {},
    }),
  )

const run = (accepted: boolean, failedGates: number): FactoryRun =>
  Schema.decodeUnknownSync(FactoryRun)({
    id: "00000000-0000-4000-8000-000000000001",
    spec: { goal: "toy goal", acceptance: ["works"], limits: { maxAttempts: 3, budgetMillis: 1000 } },
    attempts: [
      {
        attempt: 1,
        report: {
          verdicts: Array.from({ length: Math.max(1, failedGates) }, (_, i) =>
            i < failedGates
              ? {
                  _tag: "fail",
                  gate: "bun-test",
                  durationMs: 1,
                  findings: [{ rule: "test/bun-test", severity: "error", message: "boom" }],
                }
              : { _tag: "pass", gate: "bun-test", durationMs: 1, findings: [] },
          ),
        },
        filesTouched: [],
        durationMs: 1,
      },
    ],
    outcome: accepted
      ? { _tag: "accepted", attempt: 1 }
      : { _tag: "rejected", reason: "attempts-exhausted" },
    startedAt: 0,
    endedAt: 10,
  })

describe("workspaceView — the idle dashboard model", () => {
  test("specs map slug/status/goal; runs are newest-first with gate-reject counts", () => {
    const view = workspaceView(
      [doc("alpha", "locked"), doc("beta", "draft")],
      [run(false, 1), run(true, 0)],
      Option.none(),
    )
    expect(view.specs).toEqual([
      { slug: "alpha", status: "locked", goal: "the alpha goal" },
      { slug: "beta", status: "draft", goal: "the beta goal" },
    ])
    expect(view.runs[0]?.accepted).toBe(true)
    expect(view.runs[1]?.accepted).toBe(false)
    expect(view.runs[1]?.text).toContain("1 gate reject(s)")
    expect(view.lessons).toEqual([])
  })

  test("lessons keep only the bullet lines, prefix stripped", () => {
    const view = workspaceView(
      [],
      [],
      Option.some("## Lessons from past forge runs\n\n- [a/b] failed twice\n- [c/d] failed once\nnoise"),
    )
    expect(view.lessons).toEqual(["[a/b] failed twice", "[c/d] failed once"])
  })

  test("runLine renders both outcomes", () => {
    expect(runLine(run(true, 0)).text).toContain("✓ accepted (attempt 1)")
    expect(runLine(run(false, 2)).text).toContain("✗ rejected — attempts-exhausted")
  })
})
