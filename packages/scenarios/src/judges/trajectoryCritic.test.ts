import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { runScenario } from "../framework/run.js"
import {
  gradesToScore,
  lastGradesJson,
  makeTrajectoryCritic,
} from "./trajectoryCritic.js"

const world = { trail: "USER: do the thing\nASSISTANT: done", outcome: "accepted after 1 attempt(s)" }

const critic = (reply: string) =>
  makeTrajectoryCritic<typeof world>({
    transcript: (w) => Effect.succeed(w.trail),
    outcome: (w) => Effect.succeed(w.outcome),
    call: () => Effect.succeed(reply),
  })

const GOOD_REPLY = `The agent planned well.
{"planning": 5, "tool_selection": 4, "interpretation": 5, "efficiency": 3, "robustness": 4, "summary": "solid run"}`

describe("the trajectory critic judge", () => {
  test("canned rubric reply → Σaxes/25 with a per-axis reason", async () => {
    const verdict = await Effect.runPromise(critic(GOOD_REPLY).run(world))
    expect(verdict.score).toBeCloseTo(21 / 25, 5)
    expect(verdict.reason).toContain("solid run")
    expect(verdict.reason).toContain("planning 5/5")
    expect(verdict.reason).toContain("efficiency 3/5")
  })

  test("lastGradesJson takes the LAST grades block (reasoning may contain braces)", () => {
    const noisy = `thinking {"planning": 1} more prose\n${GOOD_REPLY}`
    expect(lastGradesJson(noisy)).toContain('"robustness": 4')
  })

  test("a malformed reply FAILS the judge effect — the runner captures it as score 0", async () => {
    const result = await Effect.runPromise(
      runScenario(
        {
          name: "with-critic",
          modes: ["live"],
          boot: Effect.succeed(world),
          steps: [{ name: "s1", act: () => Effect.void, checks: [] }],
          judges: [critic("no json here at all")],
        },
        "live",
        1,
      ),
    )
    expect(result.judges[0]?.score).toBe(0)
    expect(result.judges[0]?.reason).toContain("judge failed")
  })

  test("gradesToScore clamps naturally: all 5s = 1.0, all 1s = 0.2", () => {
    const all = (n: number) =>
      ({ planning: n, tool_selection: n, interpretation: n, efficiency: n, robustness: n, summary: "" })
    expect(gradesToScore(all(5))).toBe(1)
    expect(gradesToScore(all(1))).toBeCloseTo(0.2, 5)
  })
})
