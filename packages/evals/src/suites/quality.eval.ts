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

/** Everything the JUDGE grades against: the agent's final answer plus the full
 *  post-run contents of EVERY read-back file. Multi-file scenarios (e.g. a rename
 *  across two files) need all of them — judging only the single `expect.file`
 *  blinds the judge to cross-file consistency the rubric asks about (the refactor
 *  rubric checks the call site in `use.ts`, not just the export in `math.ts`). */
const judgeSubject = (output: ScenarioRun): string => {
  const fileDump = Object.entries(output.files)
    .map(([p, c]) => `// ${p}\n${c}`)
    .join("\n\n")
  return [output.finalText, fileDump].filter((s) => s.trim().length > 0).join("\n\n")
}

/** The text the OBJECTIVE substring check runs against: the specific file the
 *  scenario targets (`expect.file`), else the full judge subject. Kept narrow so
 *  a `mustNotContain` isn't accidentally satisfied (or violated) by another file. */
const objectiveText = (output: ScenarioRun, e: NonNullable<Expected["expect"]>): string => {
  if (e.file !== undefined && (output.files[e.file]?.length ?? 0) > 0) return output.files[e.file]!
  return judgeSubject(output)
}

/** Iteration aid: `QUALITY_FILTER="bug-fix,refactor"` narrows the golden set to
 *  scenarios whose name contains any listed substring (comma-separated). Unset ⇒
 *  the whole set. Lets a prompt-tuning loop re-run only the affected scenarios. */
const FILTER = process.env["QUALITY_FILTER"]?.trim()
const SCENARIOS =
  FILTER === undefined || FILTER.length === 0
    ? GOLDEN
    : GOLDEN.filter((s) => FILTER.split(",").some((f) => s.name.includes(f.trim())))

export const quality = defineEval<Input, ScenarioRun, Expected, EvalEnv>({
  name: "quality",
  description:
    "End-to-end quality scorecard: graded rubric + routing/tier correctness + efficiency over a labeled golden set.",
  threshold: 0.5,
  data: SCENARIOS.map((s) => ({
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
      output: judgeSubject(output),
    })),
    routingScore<Input, Expected>("routing"),
    efficiencyScore<Input, Expected>("efficiency"),
    predicate<Input, ScenarioRun, Expected>("objective", ({ output, expected }) => {
      const e = expected.expect
      if (e === undefined) return true
      const text = objectiveText(output, e)
      const has = (e.mustContain ?? []).every((n) => text.includes(n))
      const lacks = (e.mustNotContain ?? []).every((n) => !text.includes(n))
      return has && lacks
    }),
  ],
})
