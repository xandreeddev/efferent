import { Effect } from "effect"
import { defineEval, type Scorer } from "../framework/Eval.js"
import { predicate } from "../framework/scorers.js"
import { runScenario, type ScenarioRun } from "../support/scenarioRun.js"
import type { EvalEnv } from "../env.js"

/**
 * **Research efficiency** — does a SMALL research question converge within a
 * fetch/token/spawn budget, instead of over-researching into a runaway? The
 * `swarm` suite only checks the fleet *delivered* (a 69-`web_fetch` runaway that
 * still emits a URL scores a perfect 1.0 there). This suite scores the
 * EFFICIENCY of getting there — directly from the fleet-wide trajectory
 * (`ScenarioRun.tools` carries every sub-agent's tool call; `perTierSpend` the
 * billed tokens) — so the over-research pathology is a hard, measurable fail.
 *
 * It's the deterministic guard on the per-sub-agent web-lookup budget
 * (`Settings.subAgentFetchBudget`) + the right-sized fan-out: a regression that
 * lets researchers crawl again, or the coordinator fan a committee at a 2-item
 * question, tanks `fetch_budget`/`spawn_budget` here.
 *
 * Live + network-dependent + slow (a full fleet per case) → key-gated, sequential.
 */

interface Input {
  readonly files: Record<string, string>
  readonly prompt: string
}
interface Budget {
  readonly maxWebFetch: number
  readonly maxTotalTokens: number
  readonly maxSpawns: number
}
interface Expected {
  readonly budget: Budget
  readonly minSpawns: number
}

const countTool = (o: ScenarioRun, name: string): number =>
  o.tools.filter((t) => t === name).length

const totalTokens = (o: ScenarioRun): number => {
  const s = o.trajectory.perTierSpend
  return s.general + s.code + s.fast
}

/** Graded budget scorer: 1 within the cap, linear decay past it (mirrors
 *  `efficiencyScore`), with the observed value in the detail for the scorecard. */
const budgetScorer = (
  name: string,
  read: (o: ScenarioRun) => number,
  cap: (b: Budget) => number,
): Scorer<Input, ScenarioRun, Expected> => ({
  name,
  score: ({ output, expected }) =>
    Effect.sync(() => {
      const max = cap(expected.budget)
      const n = read(output)
      const score = max <= 0 || n <= max ? 1 : Math.max(0, 1 - (n - max) / max)
      return { score, detail: `${n} (budget ${max})` }
    }),
})

// One-shot run: there is no human + no headless auto-block in the eval harness,
// so the prompt forces the root to BLOCK on the fleet and synthesize (same shape
// as swarm.eval). The scope is deliberately TINY — a couple of sources is plenty.
const tightResearch = (question: string): string =>
  `Research question: ${question} This is a ONE-SHOT run, so you must BLOCK and deliver the answer yourself: ` +
  'spawn the research fleet — run_agent({ agent: "research-coordinator", folder: ".", task: "<the question + return a short sourced summary>" }) — ' +
  "then call wait_for_agents and LOOP it until allDone is true; do NOT end your turn until the fleet has finished. " +
  "Keep it TIGHT — this is a small question, a couple of sources is plenty; do not over-research. " +
  "Synthesize the findings into your FINAL message with at least one source URL (http...)."

const CASES: ReadonlyArray<{
  name: string
  input: Input
  expected: Expected
}> = [
  {
    name: "two-frameworks",
    input: {
      files: { "NOTES.md": "# scratch\n" },
      prompt: tightResearch(
        "name TWO open-source TypeScript AI-agent frameworks and one differentiator each.",
      ),
    },
    // With the per-researcher fetch cap (15) + a right-sized fan-out, a 2-item
    // question lands well under these; the old 69-fetch runaway scores ~0 here.
    expected: { budget: { maxWebFetch: 20, maxTotalTokens: 700_000, maxSpawns: 4 }, minSpawns: 1 },
  },
  {
    name: "single-fact",
    input: {
      files: { "NOTES.md": "# scratch\n" },
      prompt: tightResearch(
        "what year was the TypeScript language first publicly released? One sentence, one source.",
      ),
    },
    expected: { budget: { maxWebFetch: 10, maxTotalTokens: 400_000, maxSpawns: 3 }, minSpawns: 1 },
  },
]

export const researchEfficiencyEval = defineEval<Input, ScenarioRun, Expected, EvalEnv>({
  name: "research-efficiency",
  description:
    "a small research task converges within a fetch/token/spawn budget (not a 69-fetch runaway)",
  threshold: 0.6,
  concurrency: 1, // a full fleet per case — don't fan out
  data: CASES,
  task: (input) => runScenario(input.files, input.prompt, {}),
  scorers: [
    // Quality floor: the budget can't be "won" by doing nothing — a sourced answer.
    predicate("delivered", ({ output }) => output.finalText.toLowerCase().includes("http")),
    // The fleet engaged (so this measures fleet efficiency, not a solo root).
    predicate(
      "fleet_engaged",
      ({ output, expected }) =>
        output.trajectory.delegated && output.trajectory.spawns.length >= expected.minSpawns,
    ),
    budgetScorer("fetch_budget", (o) => countTool(o, "web_fetch"), (b) => b.maxWebFetch),
    budgetScorer("spawn_budget", (o) => o.trajectory.spawns.length, (b) => b.maxSpawns),
    budgetScorer("token_budget", totalTokens, (b) => b.maxTotalTokens),
  ],
})
