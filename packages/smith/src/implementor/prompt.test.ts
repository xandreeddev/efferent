import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { Spec } from "@xandreed/foundry"
import { renderBrief, renderRetryBrief, renderTaskBrief } from "./prompt.js"

const spec = Effect.runSync(
  Schema.decodeUnknown(Spec)({
    goal: "implement stringStats with Option-returning longest",
    acceptance: ["longest returns Option<string>", "histogram counts words"],
    limits: { maxAttempts: 3, budgetMillis: 60_000 },
  }),
)

describe("implementor briefs", () => {
  test("attempt 1 carries the goal, every acceptance line, and the gate framing", () => {
    const brief = renderTaskBrief(spec)
    expect(brief).toContain("implement stringStats")
    expect(brief).toContain("longest returns Option<string>")
    expect(brief).toContain("histogram counts words")
    expect(brief).toContain("quality gates")
    expect(brief).toContain("never ask questions")
  })

  test("no acceptance criteria → no empty acceptance section", () => {
    const bare = Effect.runSync(
      Schema.decodeUnknown(Spec)({
        goal: "do the thing",
        acceptance: [],
        limits: { maxAttempts: 1, budgetMillis: 1_000 },
      }),
    )
    expect(renderTaskBrief(bare)).not.toContain("Acceptance criteria")
  })

  test("retry brief embeds the feedback verbatim", () => {
    const feedback = "[effect/no-let] src/x.ts:3 — `let` is banned"
    const brief = renderRetryBrief(feedback)
    expect(brief).toContain(feedback)
    expect(brief).toContain("REJECTED")
  })

  test("workspace RULES render before lessons — the human's instructions outrank history", () => {
    const rules = "## Workspace rules (AGENTS.md — the human's standing instructions; obey them)\nNever touch src/legacy/."
    const lessons = "## Lessons from past forge runs in this workspace\n- [effect/no-let] failed twice"
    const brief = renderBrief(spec, Option.none(), Option.some(lessons), Option.some(rules))
    expect(brief).toContain("Never touch src/legacy/")
    expect(brief).toContain("failed twice")
    expect(brief.indexOf("Workspace rules")).toBeLessThan(brief.indexOf("Lessons from past forge runs"))
    // Absent extras leave the base brief untouched.
    expect(renderBrief(spec, Option.none())).toBe(renderTaskBrief(spec))
  })
})
