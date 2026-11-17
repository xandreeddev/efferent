// Lesson 19's calibration.ts: how the page checks the graders. It is shown
// read-only, so nothing of the check is hidden: what a grader is handed
// (`Case`), each label as the package's calibration takes it, the row the
// page's table draws of each check (`rowOf`), the judge, one calibration for
// each grader, and the run. The text is TypeScript; the page runs it as
// JavaScript, with no compiler in between, so what the page runs is this
// text with its types taken out, by named pieces (`TYPES`). program.test.ts
// compiles this text and runs it, and checks that the pieces are each in it
// once and that nothing else differs.
import { replaced } from "../base/agent.source.ts"

/** The file's comment: what it does. */
const INTRO = `// How the page checks your graders. labels.ts holds the answers a person labelled, and graders.ts
// the graders. This file runs each grader on every labelled answer and compares its verdict with
// the label, with the eval package's calibration: one for each grader. It is read-only: the page
// runs this text with its types taken out.
`

/** What calibration.ts imports: the page gives the names its value imports list. */
export const CALIBRATION_IMPORTS = `import { Effect, Layer, Option, Schema } from "effect"
import {
  calibrateGrader,
  CalibrationObservation,
  defineEvaluationApp,
  defineGraderCalibration,
  EvalId,
  EvaluationRunStore,
  EvaluationServicesLive,
  graderFromEvaluator,
  SemanticJevLive,
} from "@xandreed/evals"
import type { CalibrationReference, DatasetCase, SemanticJevOptions, Trial } from "@xandreed/evals"
import { graders } from "./graders.ts"
import { labels } from "./labels.ts"
`

/** What a grader is handed, each label as a calibration's case, and the table's row: everything above the judge. */
const ABOVE = `// What a grader is handed: one labelled answer, without its label. The label never reaches a
// grader: the package puts it beside the grader's verdict after the grader ran.
export const Case = Schema.Struct({
  question: Schema.String,
  reference: Schema.String,
  answer: Schema.String,
})
export type Case = typeof Case.Type

// One label as the package's calibration takes it: the case, and the verdict a right grader gives
// it, its one metric, correct, yes or no, which must be met exactly (tolerance 0). family groups
// cases that are alike (each is its own here), split names the part of a dataset a run uses
// (these are all "calibration"), and provenance says where the case came from. The label was
// reviewed: a person wrote it and read it again, and a calibration does not pass on labels no one
// has read.
const labelled = (one: (typeof labels)[number]): DatasetCase<Case, CalibrationReference> => ({
  id: one.id,
  family: one.id,
  split: "calibration",
  review: "reviewed",
  provenance: "labelled by a person",
  input: { question: one.question, reference: one.reference, answer: one.answer },
  reference: {
    status: "scored",
    metrics: [{ metric: { kind: "boolean", name: "correct", value: one.label }, tolerance: 0 }],
  },
})

// One row of the page's table: what one grader said of one labelled answer, beside its label. The
// package runs each grader on each labelled answer as a trial, as lesson 13 ran each task. The
// verdict and its reason are what the grader was seen to say. Whether it agrees with the label,
// and whether it is a false pass (yes where the label says wrong) or a false fail (no where the
// label says right), is the package's agreement grade. A grader that gave no grade (its request
// to Jev failed) disagrees, and its reason says why. A check not graded yet is no row.
export const rowOf = (trial: Trial) => {
  const observed = Option.flatMap(trial.output, Schema.decodeUnknownOption(CalibrationObservation))
  const agreement = trial.grades.flatMap((grade) => grade.metrics)
  const said = (name: string) =>
    agreement.some((metric) => metric.name === name && metric.value === true)
  return Option.map(
    Option.filter(observed, () => trial.grades.length > 0),
    (seen) => {
      const correct = seen.metrics.find((metric) => metric.name === "correct")
      return {
        grader: trial.suiteId,
        id: trial.task.id,
        label: labels.find((one) => one.id === trial.task.id)?.label === true,
        verdict: correct?.kind === "boolean" ? (correct.value ? "yes" : "no") : "no grade",
        agrees: said("agreement"),
        falsePass: said("false-pass"),
        falseFail: said("false-fail"),
        reason: seen.reason,
      }
    },
  )
}

`

/** Where the names the page gives start: the comment above the judge. Everything above it is at a typed module's top. */
export const PAGE_GIVES = "// The judge, and the run. evaluate and hear come from the page, as model does in agent.ts."

/** The rest of the file: the judge, the calibrations, the store and the run. */
const RUN = `// The judge, and the run. evaluate and hear come from the page, as model does in agent.ts.
// evaluate sends one request to Jev, a decision model: it reads one text, and answers each
// question about it with a probability. With an AI Gateway key kept in the model list, the real
// Jev answers. Without one, a stand-in answers with Jev's recorded answers to the starter's eight
// cases, and refuses any other request. hear is told of each check as the run writes it, so the
// table fills as checks end.
const judge = SemanticJevLive({ evaluate })

// One calibration for each grader: the grader runs on every labelled answer, and the package
// compares each verdict with its label. kind says what the grader is, as graders.ts says it:
// "code" for a rule written in code, "model" for a grader that asks a model.
const calibrations = Effect.forEach(
  graders,
  (evaluator) =>
    defineGraderCalibration({
      id: evaluator.id,
      version: evaluator.version,
      description: \`grader \${evaluator.id} against the labels\`,
      input: Case,
      cases: labels.map(labelled),
      grader: graderFromEvaluator(
        {
          definition: {
            id: EvalId.make(evaluator.id),
            version: evaluator.version,
            kind: evaluator.kind,
            metrics: evaluator.metrics,
            fingerprints: {},
          },
          input: Case,
          evaluator,
        },
        judge,
      ),
    }),
  { concurrency: 1 },
)

// Where the run's results go: to the page alone. The runner writes a check as it starts, as it
// ends, and once it is graded.
const store = Layer.succeed(EvaluationRunStore, {
  writeTrial: (trial) => Effect.sync(() => hear(trial)),
  appendTranscript: () => Effect.void,
  writeRun: () => Effect.void,
})

// The check: one app holds every grader's calibration, and each is run, one after the other.
// defineGraderCalibration made, for each grader, what the package needs to run it: a runnable (the
// grader, run on each labelled answer), a projection (what is handed to the grade that compares it
// with the label) and an environment (none here). environmentFor says which environment each
// runnable runs in; fingerprints and commands are for runs a command line keeps, and stay empty.
export const checked = Effect.gen(function* () {
  const made = yield* calibrations
  const app = defineEvaluationApp({
    id: "graders",
    suites: [],
    calibrations: made.map((one) => one.calibration),
    runnables: made.map((one) => one.runnable),
    graders: made.flatMap((one) => one.graders),
    projections: made.flatMap((one) => one.projections),
    environmentFor: Object.fromEntries(
      made.map((one) => [one.runnable.definition.id, one.environment.id]),
    ),
    fingerprints: {},
    commands: {},
  })
  return yield* Effect.forEach(
    made,
    (one) =>
      calibrateGrader(app, one.calibration.id, \`check-\${one.calibration.id}\`, {
        ids: [],
        split: "all",
      }),
    { concurrency: 1 },
  ).pipe(Effect.provide(EvaluationServicesLive(app)))
}).pipe(Effect.provide(store))
`

/** calibration.ts as the page shows it, and as a test compiles it with `calibrationModuleOf`. */
export const CALIBRATION = `${INTRO}${CALIBRATION_IMPORTS}
${ABOVE}${RUN}`

/** What is taken out of calibration.ts for the page to run it, as `[from, to]`: its imports and every type. Each `from` is in the text once. */
export const TYPES: ReadonlyArray<readonly [string, string]> = [
  [`${CALIBRATION_IMPORTS}\n`, ""],
  ["export type Case = typeof Case.Type\n", ""],
  ["const labelled = (one: (typeof labels)[number]): DatasetCase<Case, CalibrationReference> => ({", "const labelled = (one) => ({"],
  ["export const rowOf = (trial: Trial) => {", "export const rowOf = (trial) => {"],
  ["const said = (name: string) =>", "const said = (name) =>"],
]

/** calibration.ts as the page runs it: statements, without its imports, its types and `export`. */
export const calibrationBodyOf = (calibration: string): string => replaced(calibration, TYPES).replace(/^export /gm, "")

/**
 * The same file as a module a test can compile and run. Everything above the judge stays at the module's top, so
 * graders.ts's typed module imports `Case` from it; the rest is inside `run`, whose parameters are what the page gives
 * and no import names, `evaluate` and `hear`. `run` states that the check needs nothing more.
 */
export const calibrationModuleOf = (calibration: string): string => {
  const at = calibration.indexOf(PAGE_GIVES)
  return `${calibration.slice(0, at)}export const run = (
  evaluate: SemanticJevOptions["evaluate"],
  hear: (trial: Trial) => void,
): Effect.Effect<unknown, unknown> => {
${calibration.slice(at).replace(/^export /gm, "")}
  return checked
}
`
}

/** The whole file as the learner reads it. */
export const calibrationDocumentOf = (): string => CALIBRATION
