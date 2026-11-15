// The one source of truth for lesson 13's agent.ts: the base program (lesson
// 2's, on the kernel's modelAnswer and callTool) with the model call asked
// for under a plan. Three pieces change: the loop no longer takes the model
// as a service and asks for its answer through `planned(plan)`; a `plan` is
// declared above the turn, Effect's `ExecutionPlan`, whose steps provide the
// model you picked and a spare; and main provides no model, since the plan
// does. The page shows IMPORTS (read-only, folded) above the code the
// learner edits; program.test.ts compiles and runs this exact text.
import { BASE_AGENT, IMPORTS as BASE_IMPORTS, replaced, typedModule } from "../base/agent.source.ts"

/** What this lesson replaces in the base's imports, as `[from, to]`: Effect's plan and schedule, and the kernel's two names for a plan. */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [
  ['import { Effect, Stream } from "effect"', 'import { Effect, ExecutionPlan, Schedule, Stream } from "effect"'],
  [
    'import { callTool, inProcessJournal, Memory, modelAnswer, sessions } from "@xandreed/sdk/kernel"',
    'import { callTool, inProcessJournal, Memory, modelAnswer, planned, retryable, sessions } from "@xandreed/sdk/kernel"',
  ],
]

/** The base's line that takes the model as a service: the loop no longer does, the plan's step provides it. */
export const MODEL_SERVICE = "      const model = yield* LanguageModel.LanguageModel\n"

/** The base's call of the model, with its comment. */
const BASE_CALL = `        // Ask the model, with the tools offered but not run: this loop runs the calls. A call the
        // model got wrong comes through as it is ("deferred"), so it can be answered as a failure.
        // modelAnswer reads the stream for this turn: it shows each piece as it arrives, and stores
        // the answer with the calls it made and what it cost.
        const answer = yield* modelAnswer(
          model.streamText({
            prompt,
            toolkit,
            disableToolCallResolution: true,
            toolCallValidation: "deferred",
          }),
`

/** The same call, under the plan. */
export const PLANNED_CALL = `        // Ask for the answer under the plan: the model is whichever the plan's step provides. The
        // tools are offered but not run: this loop runs the calls. A call the model got wrong comes
        // through as it is ("deferred"), so it can be answered as a failure. planned holds one rule
        // of its own: an answer is made once. Once a word of it was shown, a failure is final.
        // modelAnswer reads the stream for this turn: it shows each piece as it arrives, and stores
        // the answer with the calls it made and what it cost.
        const answer = yield* modelAnswer(
          LanguageModel.streamText({
            prompt,
            toolkit,
            disableToolCallResolution: true,
            toolCallValidation: "deferred",
          }).pipe(planned(plan)),
`

/** Where the plan goes: after the step limit, above the turn that uses it. */
const STEP_LIMIT = "const MAX_STEPS = 5\n\n"

/** The plan: the lesson's subject, one comment per field. */
export const PLAN = `// The plan for every model call: a list of steps. Each step provides a model and says how often
// to try it. When a step gives up, the call goes to the next step.
const plan = ExecutionPlan.make(
  {
    // The model you picked. The page makes it fail as failures.ts says.
    provide: model,
    // Up to three tries on this step, the first one included.
    attempts: 3,
    // How long to wait before the next try.
    schedule: Schedule.spaced("1 second"),
    // Which failures are worth another try: a rate limit, a provider's own error, a lost
    // connection. Any other failure goes to the next step at once.
    while: retryable,
  },
  // The spare: a second Echo, given by the page, tried once.
  { provide: spare },
)

`

/** The base's comment on what the page gives. */
const PAGE_COMMENT = "// `pane` and `model` come from the page: the chat on the right, and the model you picked.\n"

/** This lesson's: the page gives a spare too. */
export const SPARE_COMMENT = `// \`pane\`, \`model\` and \`spare\` come from the page: the chat on the right, the model you picked,
// and a second Echo.
`

/** The base's last line of main: the model you picked. */
const PROVIDE_MODEL = "  Effect.provide(model), // the model you picked\n"

/** This lesson's: no model is given to the program, the plan gives one to each call. */
export const NO_MODEL = "  // No model here: the plan provides one to each model call.\n"

/** What this lesson replaces in the base's program, as `[from, to]`. program.test.ts fails when the base no longer holds one. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [
  [MODEL_SERVICE, ""],
  [BASE_CALL, PLANNED_CALL],
  [STEP_LIMIT, `${STEP_LIMIT}${PLAN}`],
  [PAGE_COMMENT, SPARE_COMMENT],
  [PROVIDE_MODEL, NO_MODEL],
]

/** Read-only: what the program imports. */
export const IMPORTS = replaced(BASE_IMPORTS, REPLACED_IMPORTS)

/** What the learner edits: the base program, its model calls asked for under a plan. */
export const DEFAULT_AGENT = replaced(BASE_AGENT, REPLACED)

/** Everything before the editable program. */
export const HEADER = `${IMPORTS}\n\n`

/** The whole file as the learner reads it. */
export const documentOf = (agent: string): string => `${HEADER}${agent}\n`

/**
 * The same file as a module a test can compile and run, as the base's: `spare` is a parameter of `run` beside
 * `pane` and `model`, a model as `model` is. `run` still states that its program needs nothing more, so a plan
 * whose steps provide no model, or a call that is not planned while main provides none, does not compile.
 */
export const moduleOf = (agent: string): string =>
  typedModule(IMPORTS, agent).replace(
    "model: Layer.Layer<LanguageModel.LanguageModel>)",
    "model: Layer.Layer<LanguageModel.LanguageModel>, spare: Layer.Layer<LanguageModel.LanguageModel>)",
  )
