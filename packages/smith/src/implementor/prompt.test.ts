import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { Spec } from "@xandreed/foundry"
import {
  renderBrief,
  renderPostFoldRetryBrief,
  renderRetryBrief,
  renderTaskBrief,
} from "./prompt.js"

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

  test("brief extras render in authority order: rules → doctrine → lessons → memory", () => {
    const rules = "## Workspace rules (AGENTS.md — the human's standing instructions; obey them)\nNever touch src/legacy/."
    const doctrine = "## Quality bar (ARMED in this workspace — the deterministic gates WILL reject violations; write to these rules the first time)\n- [effect/no-let] `let` and `var` are banned"
    const lessons = "## Lessons from past forge runs in this workspace\n- [effect/no-let] failed twice"
    const memory = "## Workspace memory (curated from past sessions — verify before relying on it)\n- [gotcha] bun test needs --preload"
    const brief = renderBrief(spec, Option.none(), {
      lessons: Option.some(lessons),
      rules: Option.some(rules),
      doctrine: Option.some(doctrine),
      memory: Option.some(memory),
    })
    expect(brief).toContain("Never touch src/legacy/")
    expect(brief).toContain("write to these rules the first time")
    expect(brief).toContain("failed twice")
    expect(brief).toContain("bun test needs --preload")
    expect(brief.indexOf("Workspace rules")).toBeLessThan(brief.indexOf("Quality bar"))
    expect(brief.indexOf("Quality bar")).toBeLessThan(brief.indexOf("Lessons from past forge runs"))
    expect(brief.indexOf("Lessons from past forge runs")).toBeLessThan(brief.indexOf("Workspace memory"))
    // Absent extras leave the base brief untouched.
    expect(renderBrief(spec, Option.none())).toBe(renderTaskBrief(spec))
  })

  test("the COMPACT bar rides a retry; without one the brief is unchanged", () => {
    const feedback = "[effect/no-let] src/x.ts:3 — `let` is banned"
    const compact = "## Quality bar (armed — violations WILL be rejected)\neffect/no-let · effect/no-try-catch"
    const withBar = renderRetryBrief(feedback, Option.some(compact))
    expect(withBar).toContain(feedback)
    expect(withBar).toContain("effect/no-let · effect/no-try-catch")
    // The reminder line still closes the brief.
    expect(withBar.indexOf("Quality bar")).toBeLessThan(withBar.indexOf("fix root causes"))
    expect(renderRetryBrief(feedback)).not.toContain("Quality bar")
  })

  test("POST-FOLD retry re-attaches ALL standing extras — the digest kept the task, not the doctrine", () => {
    const feedback = "[test/accept-x] exited 1"
    const brief = renderPostFoldRetryBrief(feedback, {
      rules: Option.some("## Workspace rules\nNever touch src/legacy/."),
      doctrine: Option.some("## Quality bar (ARMED)\n- [effect/no-let] banned"),
      lessons: Option.some("## Lessons\n- recurring"),
      memory: Option.some("## Workspace memory\n- [gotcha] preload"),
    })
    expect(brief).toContain(feedback)
    expect(brief).toContain("Never touch src/legacy/")
    expect(brief).toContain("Quality bar (ARMED)")
    expect(brief).toContain("recurring")
    expect(brief).toContain("preload")
    expect(brief.indexOf("REJECTED")).toBeLessThan(brief.indexOf("Workspace rules"))
  })
})
