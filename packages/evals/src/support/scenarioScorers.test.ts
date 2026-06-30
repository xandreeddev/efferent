import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import type { ScenarioRun, Trajectory } from "./scenarioRun.js"
import { efficiencyScore, orchestratorPurityScore, routingScore, type RoutingExpectation, type EfficiencyBudget } from "./scenarioScorers.js"

const traj = (over: Partial<Trajectory>): Trajectory => ({
  delegated: false,
  usedCodeTier: false,
  spawns: [],
  perTierSpend: { general: 0, code: 0, fast: 0 },
  steps: 1,
  rootTools: [],
  rootSpawnedAgents: [],
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
const purity = (output: ScenarioRun, exp: RoutingExpectation): number =>
  Effect.runSync(
    orchestratorPurityScore<unknown, { routing?: RoutingExpectation }>().score({
      input: {},
      output,
      expected: { routing: exp },
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

describe("orchestratorPurityScore — root must orchestrate, not do the work itself", () => {
  const exp: RoutingExpectation = { rootMustNotCode: true, expectLead: "coordinator" }

  it("perfect: root only orchestrated + routed through the coordinator", () => {
    expect(
      purity(
        run({ rootTools: ["run_agent", "wait_for_agents", "update_plan"], rootSpawnedAgents: ["coordinator"] }),
        exp,
      ),
    ).toBe(1)
  })
  it("the bc1b8fef failure: root coded itself + spawned no lead → low", () => {
    // rootMustNotCode: many work calls → 0 ; expectLead: no coordinator → 0 ; avg 0.
    expect(
      purity(
        run({
          rootTools: ["read_file", "read_file", "edit_file", "edit_file", "grep"],
          rootSpawnedAgents: [""],
        }),
        exp,
      ),
    ).toBe(0)
  })
  it("routed through the lead but peeked at one file → partial (purity decays)", () => {
    // expectLead 1 ; rootMustNotCode 1-0.25=0.75 ; avg 0.875.
    expect(
      purity(run({ rootTools: ["read_file", "run_agent"], rootSpawnedAgents: ["coordinator"] }), exp),
    ).toBeCloseTo(0.875)
  })
  it("the live regression: root looped on housekeeping (no work tools) but NEVER delegated → 0", () => {
    // The exact orchestrate-mode failure: update_plan/blackboard_read/
    // list_scheduled_jobs over and over, zero work tools (it has none), zero
    // spawns. The OLD scorer gave this a clean 1.0 ("touched no work tools") and
    // masked it; now an orchestrate root that never delegates scores 0.
    expect(
      purity(
        run({
          rootTools: ["update_plan", "blackboard_read", "list_scheduled_jobs", "update_plan"],
          rootSpawnedAgents: [],
        }),
        { rootMustNotCode: true },
      ),
    ).toBe(0)
  })
  it("no purity expectation ⇒ neutral 1", () => {
    expect(purity(run({ rootTools: ["edit_file"] }), {})).toBe(1)
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
