import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { initialFloor } from "./floor.js"
import type { FloorState } from "./floor.js"
import { initialRefine } from "./refine.js"
import type { RefineState } from "./refine.js"
import { flowView } from "./flow.js"

const states = (steps: ReturnType<typeof flowView>) => steps.map((s) => `${s.label}:${s.state}`)

const withDraft: RefineState = {
  ...initialRefine,
  draft: Option.some({ slug: "x" } as never),
}

describe("the flow stepper", () => {
  test("fresh refine: exploring is CURRENT, everything else pending", () => {
    const steps = flowView("refine", initialRefine, initialFloor("t", 3))
    expect(states(steps)).toEqual([
      "refine:current",
      "lock:pending",
      "forge:pending",
      "gates:pending",
      "result:pending",
    ])
    expect(steps[0]?.detail).toBe("exploring the workspace…")
  })

  test("a draft up: refine current with the iterate hint; lock invites", () => {
    const steps = flowView("refine", withDraft, initialFloor("t", 3))
    expect(steps[0]?.detail).toBe("draft up — iterate in the composer")
    expect(steps[1]?.detail).toBe(":lock when the spec is right")
  })

  test("locked: refine+lock done, forge invited", () => {
    const steps = flowView("refine", { ...withDraft, locked: true }, initialFloor("t", 3))
    expect(states(steps).slice(0, 3)).toEqual(["refine:done", "lock:done", "forge:pending"])
    expect(steps[2]?.detail).toBe(":forge to build")
  })

  test("implementing: forge CURRENT with the attempt readout", () => {
    const floor: FloorState = {
      ...initialFloor("t", 3),
      phase: "implementing",
      attempts: [{ attempt: 1, gates: [], files: 0 }],
    }
    const steps = flowView("forge", { ...withDraft, locked: true }, floor)
    expect(states(steps)).toEqual([
      "refine:done",
      "lock:done",
      "forge:current",
      "gates:pending",
      "result:pending",
    ])
    expect(steps[2]?.detail).toBe("attempt 1/3")
  })

  test("gating: the tally is live; done: the result lands", () => {
    const gating: FloorState = {
      ...initialFloor("t", 3),
      phase: "gating",
      gateNames: ["typecheck", "bun-test"],
      attempts: [
        {
          attempt: 1,
          files: 2,
          gates: [
            { name: "typecheck", state: "pass", findings: 0 },
            { name: "bun-test", state: "fail", findings: 2 },
          ],
        },
      ],
    }
    const mid = flowView("forge", { ...withDraft, locked: true }, gating)
    expect(mid[3]?.state).toBe("current")
    expect(mid[3]?.detail).toBe("✓1 ✗1 of 2")
    const done = flowView(
      "forge",
      { ...withDraft, locked: true },
      { ...gating, phase: "done", outcome: Option.some("✓ ACCEPTED after 1 attempt(s)") },
    )
    expect(done[4]?.state).toBe("done")
    expect(done[4]?.detail).toBe("✓ ACCEPTED after 1 attempt(s)")
  })
})
