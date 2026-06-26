import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { ScenarioRun, Trajectory } from "./scenarioRun.js"
import { efficiencyScore, routingScore, type RoutingExpectation, type EfficiencyBudget } from "./scenarioScorers.js"

const traj = (over: Partial<Trajectory>): Trajectory => ({
  delegated: false,
  usedCodeTier: false,
  spawns: [],
  perTierSpend: { general: 0, code: 0, fast: 0 },
  steps: 1,
  ...over,
})
const run = (over: Partial<Trajectory>): ScenarioRun => ({
  tools: [],
  finalText: "",
  files: {},
  trajectory: traj(over),
})

// routingScore/efficiencyScore always return a bare number (Effect.sync).
const routing = (output: ScenarioRun, exp: RoutingExpectation): number =>
  Effect.runSync(
    routingScore<unknown, { routing?: RoutingExpectation }>().score({
      input: {},
      output,
      expected: { routing: exp },
    }) as Effect.Effect<number>,
  )
const efficiency = (output: ScenarioRun, exp: EfficiencyBudget): number =>
  Effect.runSync(
    efficiencyScore<unknown, { budget?: EfficiencyBudget }>().score({
      input: {},
      output,
      expected: { budget: exp },
    }) as Effect.Effect<number>,
  )

describe("routingScore — coding task that should delegate to the code tier", () => {
  const exp: RoutingExpectation = { shouldDelegate: true, codingTier: "code" }

  it("perfect: delegated AND ran on the code tier", () => {
    expect(routing(run({ delegated: true, usedCodeTier: true, spawns: [{ name: "w", role: "code", ok: true, filesChanged: 1, files: [], tokens: 10 }] }), exp)).toBe(1)
  })
  it("the recurring failure: root coded directly (no delegate, no code tier) scores low", () => {
    // delegate-match 0 + code-tier 0 → 0.
    expect(routing(run({ delegated: false, usedCodeTier: false }), exp)).toBe(0)
  })
  it("delegated but on the WRONG (general) tier → half credit", () => {
    // delegate-match 1 + code-tier 0 → 0.5.
    expect(routing(run({ delegated: true, usedCodeTier: false, spawns: [{ name: "w", role: "general", ok: true, filesChanged: 0, files: [], tokens: 5 }] }), exp)).toBe(0.5)
  })
})

describe("routingScore — read-only task that should stay direct", () => {
  const exp: RoutingExpectation = { shouldDelegate: false, codingTier: "general" }

  it("perfect: no spawns, no code-tier spend", () => {
    expect(routing(run({ delegated: false, usedCodeTier: false }), exp)).toBe(1)
  })
  it("over-spawned a simple task → penalized", () => {
    // delegate-match 0 + over-spawn penalty (1 - 1*0.5=0.5) + code-tier-general 1 → (0+0.5+1)/3.
    const s = routing(run({ delegated: true, spawns: [{ name: "w", role: "general", ok: true, filesChanged: 0, files: [], tokens: 1 }] }), exp)
    expect(s).toBeLessThan(0.6)
  })
  it("no routing expectation ⇒ neutral 1", () => {
    expect(routing(run({}), {})).toBe(1)
  })
})

describe("efficiencyScore", () => {
  it("within budget ⇒ 1", () => {
    expect(efficiency(run({ steps: 4 }), { maxSteps: 8 })).toBe(1)
  })
  it("over budget ⇒ decays linearly", () => {
    expect(efficiency(run({ steps: 12 }), { maxSteps: 8 })).toBeCloseTo(0.5) // 1 - (12-8)/8
  })
  it("no budget ⇒ neutral 1", () => {
    expect(efficiency(run({ steps: 99 }), {})).toBe(1)
  })
})
