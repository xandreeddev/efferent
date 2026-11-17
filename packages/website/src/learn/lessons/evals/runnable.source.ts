// Lesson 13's runnable.ts: how the page runs the evals of evals.ts. It is
// shown read-only, so nothing of the eval is hidden: the runnable (the
// program agent.ts exports, given one task's message on a stack of its
// own), the projection (what a grader is handed), the candidates (the models
// compared), the app, and the run, once for each candidate. The text is
// TypeScript; the page runs it as JavaScript, with no compiler in between,
// so what the page runs is this text with its types taken out, by named
// pieces (`TYPES`). program.test.ts compiles this text and runs it, and
// checks that the pieces are each in it once and that nothing else differs.
// The lines that run the program for a trial are lesson 12's `turnsAfter`,
// derived from its text by named pieces (`REPLACED`).
import { replaced } from "../base/agent.source.ts"
import { TURNS_AFTER, TYPED as CHECKS_TYPED } from "../test-your-agent/checks.source.ts"

/** The file's comment: what it does, and which file does what. */
const INTRO = `// How the page runs your evals. evals.ts says what is measured: the tasks, the graders, how many
// times each task is run, and the gates. This file says how: it binds the program agent.ts exports
// as the runnable, hands each grader what a trial did beside the task's reference, names the
// candidates, and runs the suite once for each. It is read-only: the page runs this text with
// its types taken out.
`

/** What runnable.ts imports: the page gives the names its value imports list. */
export const RUNNABLE_IMPORTS = `import { Effect, Fiber, Layer, Option, Queue, Schema } from "effect"
import type { LanguageModel } from "effect/ai"
import { kernel, Sessions } from "@xandreed/core/kernel"
import { inProcessJournal, sessions, turnsOf } from "@xandreed/sdk/kernel"
import type { TurnRead } from "@xandreed/sdk/kernel"
import {
  compareDecisionTrials,
  decisionTrialOf,
  defineRunnable,
  EvalId,
  EvaluationError,
  EvaluationRunStore,
  EvaluationServicesLive,
  evaluationEnvironmentPort,
  EvidenceProjector,
  graderFromEvaluator,
  gradingContext,
  runEvaluation,
  runnableExecutionPort,
  tasksFromDataset,
  TrialRecorder,
} from "@xandreed/evals"
import type { DecisionTrial, EvaluationApp, Trial } from "@xandreed/evals"
import { program } from "./agent.ts"
import { Chat, chatOn } from "./chat.ts"
import type { ChatPane } from "./chat.ts"
import { dataset, evaluators, gates, repetitions } from "./evals.ts"
import { flatMemory } from "./memory.ts"
import { toolsLive } from "./tools.ts"
`

/** Lesson 12's comment above `turnsAfter`: it speaks of a check. */
const CHECK_COMMENT = `// Run the program for a check. It is the program main runs, over a stack of the check's own: the
// same modules, the model the check gives, and a chat that is a list. Each message is sent once
// the one before it is answered, so each is a turn of its own. What comes back is the journal the
// program left, read as its turns.
`

/** The same comment, of a trial. */
const TRIAL_COMMENT = `// Run the program for one trial: lesson 12's lines. It is the program main runs, over a stack of
// the trial's own: the same modules, the candidate's model, and a chat that is a list. Each
// message is sent once the one before it is answered. What comes back is the journal the
// program left, read as its turns.
`

/** Lesson 12's line that gives the model, with its comment. */
const CHECK_MODEL = "Effect.provide(model), // a model that follows a script, or the model you picked"

/** The same line here. */
const TRIAL_MODEL = "Effect.provide(model), // the candidate's model"

/** What this file replaces in lesson 12's `turnsAfter`, as `[from, to]`: its comment, and the model's line. Each `from` is in lesson 12's text once. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [CHECK_COMMENT, TRIAL_COMMENT],
  [
    "Send is a function the check calls, and an answer or a failure goes\n    // onto a queue the check waits on.",
    "Send is a function the trial calls, and an answer or a failure goes\n    // onto a queue the trial waits on.",
  ],
  ["If it stopped, the check stops too, with the reason.", "If it stopped, the trial stops too, with the reason."],
  ["a journal of the check's own, kept in the page", "a journal of the trial's own, kept in the page"],
  [CHECK_MODEL, TRIAL_MODEL],
]

/** `turnsAfter`'s first line, as lesson 12's checks.ts has it. */
const SIGNATURE = "const turnsAfter = (model, messages) =>"

/** The same line typed, as Prettier lays it out: its parameters, and what it gives. */
const TYPED_SIGNATURE = `const turnsAfter = (
  model: Layer.Layer<LanguageModel.LanguageModel>,
  messages: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<TurnRead>, unknown> =>`

/**
 * The typed lines of `turnsAfter`: its signature, and lesson 12's typed lines of the queue, `send` and the pane, as
 * lesson 12's typed module has them.
 */
export const TURNS_AFTER_TYPED: ReadonlyArray<readonly [string, string]> = [
  [SIGNATURE, TYPED_SIGNATURE],
  ...CHECKS_TYPED.filter(([from]) => from !== SIGNATURE && TURNS_AFTER.includes(from)),
]

/** `turnsAfter` as this file holds it: lesson 12's, typed, of a trial. */
const TRIAL_TURNS = replaced(replaced(TURNS_AFTER, REPLACED), TURNS_AFTER_TYPED)

/** The evidence, and what a grader is handed: the part of the file above the candidates, after `turnsAfter`. */
const EVIDENCE = `// What a trial keeps of its turns, as JSON: what was said, each step's text and the calls it
// made with their results, and the answer. This is the evidence a grader reads.
const Call = Schema.Struct({
  name: Schema.String,
  input: Schema.Json,
  result: Schema.NullOr(Schema.Json),
})
const Turn = Schema.Struct({
  messages: Schema.Array(Schema.String),
  steps: Schema.Array(Schema.Struct({ text: Schema.String, calls: Schema.Array(Call) })),
  answer: Schema.NullOr(Schema.String),
})
const Evidence = Schema.Array(Turn)
const evidenceOf = (turns: ReadonlyArray<TurnRead>): typeof Evidence.Type =>
  turns.map((turn) => ({
    messages: turn.messages.map((message) => message.text),
    steps: turn.steps.map((step) => ({
      text: step.text,
      calls: step.calls.map((call) => ({
        name: call.name,
        input: call.input,
        result: Option.getOrNull(Option.map(call.result, (done) => done.result)),
      })),
    })),
    answer: Option.getOrNull(turn.answer),
  }))

// What a grader is handed: the turns, and the task's reference beside them. The program never
// sees a reference: it is put here after the trial ran.
export const Graded = Schema.Struct({ turns: Evidence, reference: dataset.reference })
export type Graded = typeof Graded.Type

// The runnable's port: its input is the message, its output the answer, its evidence the turns.
// A trial opens no world of its own: its environment gives none.
const Runnable = runnableExecutionPort<string, string, typeof Evidence.Type, null>("lesson-program")
const Environment = evaluationEnvironmentPort<string, null>("lesson-program")

// The projection: what each grader is handed, within a budget of bytes.
const BUDGET = { maxBytes: 20_000, reservedBytes: 1_000 }
const projection = {
  definition: { id: EvalId.make("graded"), version: "1", budget: BUDGET },
  layer: Layer.succeed(EvidenceProjector, {
    project: (trial) =>
      gradingContext({
        projection: "graded",
        version: "1",
        input: { turns: Option.getOrNull(trial.evidence), reference: trial.task.reference },
        schema: Schema.Unknown,
        budget: BUDGET,
        references: [trial.id],
        omissions: [],
      }),
  }),
}

// The graders: each of evals.ts's evaluators, behind a grader of its id and version. Its input
// is what the projection hands it, read as Graded.
const graders = evaluators.map((evaluator) =>
  graderFromEvaluator(
    {
      definition: {
        id: EvalId.make(evaluator.id),
        version: evaluator.version,
        kind: "code",
        metrics: evaluator.metrics,
        fingerprints: {},
      },
      input: Graded,
      evaluator,
    },
    Layer.empty,
  ),
)

// The tasks: one for each case of the dataset, each graded by every grader.
const tasks = tasksFromDataset(dataset, {
  runnable: "program",
  graders: evaluators.map((evaluator) => ({
    grader: \`\${evaluator.id}@\${evaluator.version}\`,
    projection: "graded",
    scope: "trial",
  })),
})

// Whether a trial passed: each gate's grader scored it, and said yes. The page's table counts
// these, and the comparison below reads them.
const passed = (trial: Trial) =>
  gates.every((gate) =>
    trial.grades.some(
      (grade) =>
        \`\${grade.grader}@\${grade.version}\` === gate.grader &&
        grade.status === "scored" &&
        grade.metrics.some((metric) => metric.name === gate.metric && metric.value === true),
    ),
  )

// A trial as compareDecisionTrials reads it, made by the package's decisionTrialOf: how the trial
// ended, whether it passed (every gate's grader said yes, which passed above decides) and how
// long it took. A model whose call fails gives no answer: its turn ends failed,
// the trial completes, and the graders fail it. A trial that did not complete (its stack did not
// run, or the page stopped it) is no finding about the model: it is "infrastructure", which the
// comparison counts apart and never takes for a regression, and the table says "error". A trial
// still running is no row yet.
export const rowOf = (trial: Trial): Option.Option<DecisionTrial> =>
  decisionTrialOf(trial, { passed: passed(trial) })
`

/** Where the names the page gives start: the comment above the candidates. Everything above it is at a typed module's top. */
export const PAGE_GIVES = "// The candidates: one for each model the page gives, by name."

/** The rest of the file: the candidates, the runnable bound to them, the store, the app and the run. */
const RUN = `${PAGE_GIVES} Echo comes first: it is
// the reference solution, which passes every task, and the others are compared with it. models
// and hear come from the page, as model does in agent.ts. models is each candidate's model by
// its name: Echo, echo-no-tools (an Echo that calls no tool), and the model you picked. hear is
// told of each trial as the run writes it, so the table fills as trials end.
const candidates = Object.keys(models).map((name) => ({
  id: EvalId.make(name),
  configuration: {},
  fingerprints: {},
}))

// The runnable: a trial sends the task's message to the program, on the candidate's model.
const runnable = defineRunnable({
  definition: {
    id: EvalId.make("program"),
    version: "1",
    description: "the program agent.ts exports",
    fingerprints: {},
  },
  input: Schema.String,
  output: Schema.String,
  evidence: Evidence,
  runnable: Runnable,
  environment: Environment,
  layer: Layer.succeed(Runnable, {
    execute: (message, candidate) =>
      Effect.gen(function* () {
        const model = models[candidate.id]
        if (model === undefined)
          return yield* Effect.fail(
            new EvaluationError({ code: "invalid", message: \`no model is named \${candidate.id}\` }),
          )
        // A stack that does not run ends the trial as an error, with the reason: rowOf below says
        // it is no finding about the model. A model call that fails is no such thing: its turn
        // ends failed, and turnsAfter gives that turn back.
        const turns = yield* Effect.orDie(turnsAfter(model, [message]))
        // The transcript: every record the trial's turn stored, in order, with the message it holds
        // (a user's, the model's, a tool's result) or else its data.
        const recorder = yield* TrialRecorder
        for (const record of turns.flatMap((turn) => turn.records))
          yield* recorder.record(record.name, record.message ?? record.data)
        const evidence = evidenceOf(turns)
        return { output: evidence.at(-1)?.answer ?? "", evidence }
      }),
  }),
  environments: [
    {
      id: "none",
      layer: Layer.succeed(Environment, {
        open: () => Effect.succeed(null),
        inspect: () => Effect.succeed({ state: null, references: [] }),
      }),
    },
  ],
})

// Where the run's results go: to the page alone. The runner writes a trial as it starts, as it
// ends, and after each grade.
const store = Layer.succeed(EvaluationRunStore, {
  writeTrial: (trial) => Effect.sync(() => hear(trial)),
  appendTranscript: () => Effect.void,
  writeRun: () => Effect.void,
})

// The app: the suite, the runnable, the projection and the graders, as the package runs them.
const app: EvaluationApp = {
  id: "lesson",
  fingerprints: {},
  commands: {},
  calibrations: [],
  suites: [
    {
      id: EvalId.make("lesson"),
      version: "1",
      purpose: "regression",
      description: "the program on the lesson's tasks",
      tasks,
      candidates,
      gates,
      repetitions,
      // One trial at a time: a model on your machine answers one message at a time.
      concurrency: 1,
      // A trial may take two minutes, as a check of lesson 12 may: a model on your machine is slow.
      timeoutMs: 120_000,
    },
  ],
  runnables: [runnable],
  environmentFor: { program: "none" },
  projections: [projection],
  graders,
}

// The run: the suite once for each candidate, one after the other, so a candidate's trials are
// graded and its gates decided as soon as they have all run. Then every trial is compared with
// Echo's: the same task and repetition, passed by Echo and failed here, is a regression.
export const evaluation = Effect.forEach(
  candidates,
  (candidate) =>
    runEvaluation(app, \`run-\${candidate.id}\`, {
      ids: ["lesson"],
      split: "validation",
      candidates: [candidate.id],
    }),
  { concurrency: 1 },
).pipe(
  Effect.map((runs) => ({
    runs,
    comparison: compareDecisionTrials(
      runs.flatMap((run) => run.trials.flatMap((trial) => Option.toArray(rowOf(trial)))),
      "echo",
    ),
  })),
  Effect.provide(EvaluationServicesLive(app)),
  Effect.provide(store),
)
`

/** runnable.ts as the page shows it, and as a test compiles it with `runnableModuleOf`. */
export const RUNNABLE = `${INTRO}${RUNNABLE_IMPORTS}
${TRIAL_TURNS}

${EVIDENCE}
${RUN}`

/**
 * What is taken out of runnable.ts for the page to run it, as `[from, to]`: its imports and every type. Each `from`
 * is in the text once. `turnsAfter`'s are lesson 12's typed lines, put back as lesson 12's checks.ts has them.
 */
export const TYPES: ReadonlyArray<readonly [string, string]> = [
  [RUNNABLE_IMPORTS, ""],
  ...TURNS_AFTER_TYPED.map(([from, to]): readonly [string, string] => [to, from]),
  ["const evidenceOf = (turns: ReadonlyArray<TurnRead>): typeof Evidence.Type =>", "const evidenceOf = (turns) =>"],
  ["export type Graded = typeof Graded.Type\n", ""],
  ['runnableExecutionPort<string, string, typeof Evidence.Type, null>("lesson-program")', 'runnableExecutionPort("lesson-program")'],
  ['evaluationEnvironmentPort<string, null>("lesson-program")', 'evaluationEnvironmentPort("lesson-program")'],
  ["const passed = (trial: Trial) =>", "const passed = (trial) =>"],
  ["export const rowOf = (trial: Trial): Option.Option<DecisionTrial> =>", "export const rowOf = (trial) =>"],
  ["const app: EvaluationApp = {", "const app = {"],
]

/** runnable.ts as the page runs it: statements, without its imports, its types and `export`. */
export const runnableBodyOf = (runnable: string): string => replaced(runnable, TYPES).replace(/^export /gm, "")

/**
 * The same file as a module a test can compile and run. Everything above the candidates stays at the module's top,
 * so evals.ts's typed module imports `Graded` from it; the rest is inside `run`, whose parameters are what the page
 * gives and no import names, `models` and `hear`. `run` states that the run needs nothing more.
 */
export const runnableModuleOf = (runnable: string): string => {
  const at = runnable.indexOf(PAGE_GIVES)
  return `${runnable.slice(0, at)}export const run = (
  models: Readonly<Record<string, Layer.Layer<LanguageModel.LanguageModel>>>,
  hear: (trial: Trial) => void,
): Effect.Effect<unknown, unknown> => {
${runnable.slice(at).replace(/^export /gm, "")}
  return evaluation
}
`
}

/** The whole file as the learner reads it. */
export const runnableDocumentOf = (): string => RUNNABLE
