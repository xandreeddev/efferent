import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { SpecDoc } from "@xandreed/sdk-core"
import type { SmithEvent } from "../../domain/SmithEvent.js"
import { initialRefine, reduceRefine, withUserLine } from "./refine.js"

const doc = Effect.runSync(
  Schema.decodeUnknown(SpecDoc)({
    slug: "widget",
    status: "draft",
    created: "2026-07-07T10:00:00Z",
    goal: "Build the widget.",
    acceptance: ["it spins"],
    constraints: [],
    nonGoals: [],
    checks: [],
    limits: { maxAttempts: 3, budgetMinutes: 15 },
    gates: {},
  }),
)

const fold = (events: ReadonlyArray<SmithEvent>) => events.reduce(reduceRefine, initialRefine)

describe("reduceRefine", () => {
  test("spec_draft carries the doc; spec_locked flips the badge", () => {
    const drafted = fold([{ type: "spec_draft", doc, path: "/ws/.efferent/specs/widget.md" }])
    expect(Option.getOrThrow(drafted.draft).goal).toBe("Build the widget.")
    expect(drafted.locked).toBe(false)

    const locked = reduceRefine(drafted, {
      type: "spec_locked",
      doc,
      path: "/ws/.efferent/specs/widget.md",
    })
    expect(locked.locked).toBe(true)
  })

  test("assistant text lands in the transcript; tool calls in the feed", () => {
    const state = fold([
      {
        type: "agent",
        event: { type: "assistant_message", turnIndex: 0, text: "Two questions: …" },
      },
      {
        type: "agent",
        event: { type: "tool_call_start", turnIndex: 0, id: "1", toolName: "grep", args: { pattern: "widget" } },
      },
    ])
    expect(state.transcript).toEqual([{ who: "smith", text: "Two questions: …" }])
    expect(state.feed).toEqual(["⚙ grep(widget)"])
  })

  test("user lines interleave via withUserLine and clear the error", () => {
    const errored = fold([{ type: "refine_error", message: "boom" }])
    expect(Option.isSome(errored.error)).toBe(true)
    const next = withUserLine(errored, "tighten the goal")
    expect(next.transcript.at(-1)).toEqual({ who: "you", text: "tighten the goal" })
    expect(Option.isNone(next.error)).toBe(true)
  })

  test("forge-phase events are inert here", () => {
    const state = fold([
      { type: "attempt_start", attempt: 1 },
      { type: "gate_start", gate: "bun-test" },
    ])
    expect(state).toEqual(initialRefine)
  })
})
