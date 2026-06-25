import { defineEval } from "../framework/Eval.js"
import { predicate, qualityRubric } from "../framework/scorers.js"
import type { EvalEnv } from "../env.js"
import { GOLDEN, type Scenario } from "../dataset/golden.js"
import { runScenario, type ScenarioRun } from "../support/scenarioRun.js"
import {
  efficiencyScore,
  routingScore,
  type EfficiencyBudget,
  type RoutingExpectation,
} from "../support/scenarioScorers.js"

/**
 * The quality scorecard suite — the primary deliverable. Each golden scenario
 * runs the REAL agent loop end-to-end (`runScenario`) and is scored on four
 * axes that together answer "is this change better?":
 *   - `quality`    — graded LLM-judge rubric (correctness + scope discipline)
 *   - `routing`    — did it select the right agent/tier (delegate-when-it-should,
 *                    code-writing on the code tier, no over-spawn) — objective
 *   - `efficiency` — within the step budget — objective
 *   - `objective`  — substring must/must-not over the produced file — objective
 *
 * Run with a distinct codeModel to exercise routing:
 *   bun run eval quality --main opencode:kimi-k2.6 --code opencode:deepseek-v4-pro --judge anthropic:claude-sonnet-4-6
 */

interface Input {
  readonly files: Record<string, string>
  readonly prompt: string
  readonly readback: ReadonlyArray<string>
}
interface Expected {
  readonly rubric: string
  readonly expect?: Scenario["expect"]
  readonly routing?: RoutingExpectation
  readonly budget?: EfficiencyBudget
}

/** The text the judge / objective check reads: the produced file when the
 *  scenario names one, else the agent's final answer. */
const subject = (output: ScenarioRun, expected: Expected): string => {
  const file = expected.expect?.file
  if (file !== undefined && output.files[file] !== undefined && output.files[file]!.length > 0) {
    return output.files[file]!
  }
  // No single named file → judge the answer plus any read-back file contents.
  const fileDump = Object.entries(output.files)
    .map(([p, c]) => `// ${p}\n${c}`)
    .join("\n\n")
  return [output.finalText, fileDump].filter((s) => s.trim().length > 0).join("\n\n")
}

export const quality = defineEval<Input, ScenarioRun, Expected, EvalEnv>({
  name: "quality",
  description:
    "End-to-end quality scorecard: graded rubric + routing/tier correctness + efficiency over a labeled golden set.",
  threshold: 0.5,
  data: GOLDEN.map((s) => ({
    name: s.name,
    input: { files: s.files, prompt: s.prompt, readback: s.readback ?? [] },
    expected: {
      rubric: s.rubric,
      ...(s.expect !== undefined ? { expect: s.expect } : {}),
      ...(s.routing !== undefined ? { routing: s.routing } : {}),
      ...(s.budget !== undefined ? { budget: s.budget } : {}),
    },
  })),
  task: (input) => runScenario(input.files, input.prompt, { readback: input.readback }),
  scorers: [
    qualityRubric<Input, ScenarioRun, Expected>("quality", ({ output, expected }) => ({
      rubric: expected.rubric,
      output: subject(output, expected),
    })),
    routingScore<Input, Expected>("routing"),
    efficiencyScore<Input, Expected>("efficiency"),
    predicate<Input, ScenarioRun, Expected>("objective", ({ output, expected }) => {
      const e = expected.expect
      if (e === undefined) return true
      const text = subject(output, expected)
      const has = (e.mustContain ?? []).every((n) => text.includes(n))
      const lacks = (e.mustNotContain ?? []).every((n) => !text.includes(n))
      return has && lacks
    }),
  ],
})
