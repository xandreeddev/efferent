import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { Finding, GateName, GateReport, RuleId, Spec } from "@xandreed/foundry"
import type { SmithEvent } from "../../domain/SmithEvent.js"
import type { GateCell, GateCellState } from "./floor.js"
import { initialFloor, reduceFloor, attemptRowView } from "./floor.js"

const spec = Effect.runSync(
  Schema.decodeUnknown(Spec)({
    goal: "fix the sum",
    acceptance: [],
    limits: { maxAttempts: 3, budgetMillis: 60_000 },
  }),
)

const finding = new Finding({
  rule: RuleId.make("test/bun-test"),
  severity: "error",
  message: "expected 2, got 3",
  location: Option.none(),
  fixHint: Option.none(),
})

const failReport = new GateReport({
  verdicts: [
    { _tag: "fail", gate: GateName.make("bun-test"), durationMs: 5, findings: [finding] },
  ],
})

const passReport = new GateReport({
  verdicts: [
    { _tag: "pass", gate: GateName.make("bun-test"), durationMs: 5, findings: [] },
  ],
})

const fold = (events: ReadonlyArray<SmithEvent>) =>
  events.reduce(reduceFloor, initialFloor("fix the sum", 3))

describe("reduceFloor", () => {
  test("the happy loop: fail on attempt 1, pass on attempt 2", () => {
    const floor = fold([
      { type: "forge_start", spec, gateNames: ["bun-test"], doc: Option.none() },
      { type: "attempt_start", attempt: 1 },
      { type: "implement_end", attempt: 1, filesTouched: ["sum.ts"], ref: Option.some("conversation:abc") },
      { type: "gate_start", gate: "bun-test" },
      { type: "gate_report", attempt: 1, report: failReport, feedback: Option.some("brief") },
      { type: "attempt_start", attempt: 2 },
      { type: "implement_end", attempt: 2, filesTouched: ["sum.ts"], ref: Option.some("conversation:abc") },
      { type: "gate_start", gate: "bun-test" },
      { type: "gate_report", attempt: 2, report: passReport, feedback: Option.none() },
    ])

    expect(floor.attempts.length).toBe(2)
    expect(floor.attempts[0]!.gates[0]).toEqual({ name: "bun-test", state: "fail", findings: 1 })
    expect(floor.attempts[1]!.gates[0]).toEqual({ name: "bun-test", state: "pass", findings: 0 })
    expect(floor.attempts[1]!.files).toBe(1)
    expect(Option.getOrThrow(floor.conversationRef)).toBe("conversation:abc")
    // A new attempt clears the previous findings; the pass leaves none.
    expect(floor.findings).toEqual([])
    expect(floor.phase).toBe("gating")
  })

  test("findings render as plain [rule] message lines after a failed report", () => {
    const floor = fold([
      { type: "forge_start", spec, gateNames: ["bun-test"], doc: Option.none() },
      { type: "attempt_start", attempt: 1 },
      { type: "gate_report", attempt: 1, report: failReport, feedback: Option.none() },
    ])
    expect(floor.findings).toEqual(["[test/bun-test] expected 2, got 3"])
  })

  test("gate_start marks the cell running; forge_end records the outcome", () => {
    const running = fold([
      { type: "forge_start", spec, gateNames: ["bun-test"], doc: Option.none() },
      { type: "attempt_start", attempt: 1 },
      { type: "gate_start", gate: "bun-test" },
    ])
    expect(running.attempts[0]!.gates[0]!.state).toBe("running")
    expect(running.phase).toBe("gating")
  })

  test("agent events feed the activity ring; silent events stay silent", () => {
    const floor = fold([
      {
        type: "agent",
        event: { type: "tool_start", turnIndex: 0, toolCallId: "1", toolName: "edit_file", args: { path: "a.ts" } },
      },
      { type: "agent", event: { type: "turn_start", turnIndex: 1 } },
    ])
    expect(floor.feed).toEqual(["⚙ edit_file(a.ts)"])
  })

  test("forge_error flips the floor to failed with the message", () => {
    const floor = fold([{ type: "forge_error", message: "boom" }])
    expect(floor.phase).toBe("failed")
    expect(Option.getOrThrow(floor.error)).toBe("boom")
  })
})

describe("attemptRowView — bounded by construction", () => {
  const cell = (name: string, state: GateCellState): GateCell => ({ name, state, findings: 0 })

  test("few gates render as cells with clipped names", () => {
    const view = attemptRowView({
      attempt: 1,
      files: 2,
      gates: [
        cell("bun-test", "pass"),
        cell("accept-a-very-long-gate-name-that-exceeds-the-budget", "running"),
      ],
    })
    expect(view.mode).toBe("cells")
    expect(view.cells[1]?.name.length).toBeLessThanOrEqual(24)
    expect(view.cells[1]?.name.endsWith("…")).toBe(true)
  })

  test("many gates collapse to counts + the gate that matters (running first)", () => {
    const view = attemptRowView({
      attempt: 2,
      files: 18,
      gates: [
        cell("g1", "pass"),
        cell("g2", "pass"),
        cell("g3", "fail"),
        cell("g4", "running"),
        cell("g5", "pending"),
        cell("g6", "pending"),
      ],
    })
    expect(view.mode).toBe("compact")
    expect(view.counts).toEqual({ pass: 2, fail: 1, running: 1, pending: 2, skip: 0 })
    expect(Option.getOrThrow(view.active).name).toBe("g4")
  })

  test("no running gate → the first failure is named; else the next pending", () => {
    const failed = attemptRowView({
      attempt: 1,
      files: 0,
      gates: [cell("a", "pass"), cell("b", "fail"), cell("c", "pending"), cell("d", "pending"), cell("e", "pending")],
    })
    expect(Option.getOrThrow(failed.active).name).toBe("b")
  })
})
