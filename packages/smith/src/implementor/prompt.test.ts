import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Spec } from "@xandreed/foundry"
import { renderRetryBrief, renderTaskBrief } from "./prompt.js"

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
})
