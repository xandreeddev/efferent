import { Effect } from "effect"
import { defineEval } from "../framework/Eval.js"
import { fromEffect, qualityRubric } from "../framework/scorers.js"
import type { EvalEnv } from "../env.js"
import { FEATURES, type FeatureScenario } from "../dataset/feature.js"
import { runScenario, type ScenarioRun } from "../support/scenarioRun.js"
import {
  efficiencyScore,
  routingScore,
  type EfficiencyBudget,
  type RoutingExpectation,
} from "../support/scenarioScorers.js"

/**
 * The HARD discriminating suite — full features graded by an objective HIDDEN
 * test suite (`bun test`, run after the agent finishes) plus a demanding
 * completeness rubric. Unlike `quality` (whose toy tasks saturate at ~1.0 for
 * any competent coder, so it can't rank models on quality), these features have
 * deep edge cases where a weak coder ships a passing-but-incomplete solution —
 * the `tests` pass-RATIO is the discriminator. Run it to rank code models:
 *
 *   bun run eval feature --config packages/evals/dataset/configs/code-model-matrix.json --samples 3
 *
 * `FEATURE_FILTER="csv,tx"` narrows to scenarios whose name contains a substring.
 */

interface Input {
  readonly files: Record<string, string>
  readonly prompt: string
  readonly hiddenTests: Record<string, string>
  readonly testPaths?: ReadonlyArray<string>
  readonly readback: ReadonlyArray<string>
}
interface Expected {
  readonly rubric: string
  readonly routing?: RoutingExpectation
  readonly budget?: EfficiencyBudget
}

/** What the judge grades: the agent's final answer + the full produced impl files. */
const judgeSubject = (output: ScenarioRun): string => {
  const fileDump = Object.entries(output.files)
    .map(([p, c]) => `// ${p}\n${c}`)
    .join("\n\n")
  return [output.finalText, fileDump].filter((s) => s.trim().length > 0).join("\n\n")
}

const FILTER = process.env["FEATURE_FILTER"]?.trim().toLowerCase()
const SCENARIOS: ReadonlyArray<FeatureScenario> =
  FILTER === undefined || FILTER.length === 0
    ? FEATURES
    : FEATURES.filter((s) =>
        FILTER.split(",").some((f) => s.name.toLowerCase().includes(f.trim())),
      )

export const feature = defineEval<Input, ScenarioRun, Expected, EvalEnv>({
  name: "feature",
  description:
    "Hard full-feature scenarios graded by a hidden bun-test suite (objective pass-ratio) + a completeness rubric — the discriminating quality suite.",
  threshold: 0.4,
  // pass^k gates on the OBJECTIVE tests (all hidden tests green), not the blended
  // mean — so consistency reflects code correctness, never the LLM judge.
  gate: { scorer: "tests", min: 1 },
  data: SCENARIOS.map((s) => ({
    name: s.name,
    input: {
      files: s.files,
      prompt: s.prompt,
      hiddenTests: s.hiddenTests,
      ...(s.testPaths !== undefined ? { testPaths: s.testPaths } : {}),
      readback: s.readback,
    },
    expected: {
      rubric: s.rubric,
      ...(s.routing !== undefined ? { routing: s.routing } : {}),
      ...(s.budget !== undefined ? { budget: s.budget } : {}),
    },
  })),
  task: (input) =>
    runScenario(input.files, input.prompt, {
      readback: input.readback,
      hiddenTests: input.hiddenTests,
      ...(input.testPaths !== undefined ? { testPaths: input.testPaths } : {}),
      // Execute the agent's Bash + the hidden tests in a --network none container,
      // not on the host — this suite runs LLM-generated code.
      sandbox: true,
    }),
  scorers: [
    // The objective discriminator: fraction of the hidden test suite that passes.
    fromEffect<Input, ScenarioRun, Expected, never, never>("tests", ({ output }) =>
      Effect.sync(() => {
        const r = output.testResult
        if (r === undefined) return { score: 0, detail: "no test result" }
        return { score: r.ratio, detail: `${r.pass}/${r.pass + r.fail} pass` }
      }),
    ),
    qualityRubric<Input, ScenarioRun, Expected>("quality", ({ output, expected }) => ({
      rubric: expected.rubric,
      output: judgeSubject(output),
    })),
    routingScore<Input, Expected>("routing"),
    efficiencyScore<Input, Expected>("efficiency"),
  ],
})
