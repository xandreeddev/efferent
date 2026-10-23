import { Effect, Option } from "effect"
import { fixture } from "./fixture.testing.js"
import { EvalId } from "../domain/identity.entity.js"
import { unknownEvaluationUsage } from "../assessment.usecase.functions.js"
import type { EvaluationRun } from "../domain/evaluation-run.entity.js"
import type { ComparisonSide, ComparisonSpecification } from "../domain/comparison-specification.entity.js"
import type { Task } from "../domain/task.entity.js"
import {
  comparisonExecutionSettings, comparisonGateDefinitions, comparisonGradingFingerprint,
  comparisonPreflight, comparisonTaskFingerprint,
} from "../domain/comparison-specification.entity.functions.js"
import { runGates } from "../domain/evaluation-run.entity.functions.js"

export const comparisonFixture = (count = 30, repetitions = 2, transform: (task: Task, index: number) => Task = (task) => task) => {
  const initial = fixture()
  const suite = {
    ...initial.suites[0]!, repetitions,
    tasks: Array.from({ length: count }, (_, index) => transform({ ...initial.suites[0]!.tasks[0]!, id: EvalId.make(`task-${index}`), family: `family-${index}`, input: `input-${index}` }, index)),
    gates: initial.suites[0]!.gates.map((gate) => ({ ...gate, minimum: Option.some(0.75) })),
  }
  const graders = [...new Set(suite.tasks.flatMap((task) => task.graders.map((binding) => binding.grader)))].map((id) => ({ ...initial.graders[0]!, definition: { ...initial.graders[0]!.definition, id: EvalId.make(id.split("@")[0]!), version: id.split("@")[1]! } }))
  const base = { ...initial, graders, suites: [suite], fingerprints: { application: "before", "fixture:content": "fixture-v1" } }
  const next = { ...base, fingerprints: { ...base.fingerprints, application: "after" }, suites: [{ ...suite, candidates: suite.candidates.map((candidate) => ({ ...candidate, configuration: { instruction: "revised" } })) }] }
  const selection = { ids: [suite.id], split: "validation" }
  const specification: ComparisonSpecification = {
    version: 1, id: EvalId.make("comparison"), application: initial.id,
    hypothesis: "The revised instruction increases the primary score.",
    baseline: { candidate: suite.candidates[0]!, fingerprints: base.fingerprints },
    candidate: { candidate: next.suites[0]!.candidates[0]!, fingerprints: next.fingerprints },
    allowedFingerprintChanges: ["application"],
    tasks: suite.tasks.map((task) => ({ suiteId: suite.id, taskId: task.id, fingerprint: comparisonTaskFingerprint(task) })),
    repetitions, execution: comparisonExecutionSettings(base, selection),
    gradingConfiguration: comparisonGradingFingerprint(base), gates: comparisonGateDefinitions(base.suites),
    primary: { grader: "grader@1", metric: "correct", direction: "higher" },
    minimumImprovement: 0.05, plannedIndependentFamilies: 30, targetPower: 0.8,
    powerRationale: "Fictional test design: thirty independent families for a material paired difference; not a measured power claim.", seed: 42,
  }
  const report = (side: ComparisonSide, spec = specification, score: (index: number, sample: number) => number = (index) => side === "baseline" ? 0.4 : 0.8 + index / 1000): Effect.Effect<EvaluationRun, import("../domain/identity.entity.js").EvaluationError> => Effect.gen(function* () {
    const app = side === "baseline" ? base : next
    const fingerprints = yield* comparisonPreflight(app, selection, { specification: spec, side })
    const runId = EvalId.make(side)
    const trials = suite.tasks.flatMap((task, index) => Array.from({ length: repetitions }, (_, repetition) => ({
      version: 1 as const, id: EvalId.make(`${side}/${task.id}/${repetition + 1}`), runId, suiteId: suite.id, task,
      candidate: spec[side].candidate, sample: repetition + 1, status: "completed" as const,
      startedAt: 0, endedAt: 1, output: Option.some(score(index, repetition + 1)), evidence: Option.none(), outcome: Option.none(), transcript: [], reason: "",
      grades: task.graders.map((binding) => ({ grader: binding.grader.split("@")[0]!, version: "1", scope: binding.scope, status: "scored" as const,
        metrics: [{ kind: "score" as const, name: "correct", value: score(index, repetition + 1), min: 0, max: 1 }], reason: "controlled observation",
        context: Option.none(), usage: unknownEvaluationUsage, startedAt: 0, endedAt: 1, metadata: {},
      })),
    })))
    return { version: 1, id: runId, application: app.id, phase: "graded", startedAt: 0, endedAt: 1,
      fingerprints: { ...fingerprints, gradingConfiguration: spec.gradingConfiguration }, trials, gates: runGates(app.suites, trials), failures: [],
    }
  })
  return { base, next, selection, specification, report }
}
