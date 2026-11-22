import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { Effect, Layer, Option, Schema } from "effect"
import {
  defineEvaluationApp,
  defineRunnable,
  EvalId,
  EvaluationError,
  evaluationEnvironmentPort,
  EvidenceProjector,
  GraderAssessment,
  gradingContext,
  runnableExecutionPort,
  unknownEvaluationUsage,
} from "@xandreed/evals"
import type { EvaluationApp, Task, Trial } from "@xandreed/evals"
import { GoldCases, GoldId, Recorded, Replayed } from "./review-eval.entity.js"
import type { GoldCase } from "./review-eval.entity.js"
import { goldScore, replayed, reviewKeyOf } from "./review-eval.entity.functions.js"

/** Where the eval's fixtures are: `packages/review/evals/`, beside the package's `src`. */
const FIXTURES = fileURLToPath(new URL("../../evals/", import.meta.url))

/** A fixture read whole, or an `EvaluationError` that names it. */
const readFixture = <A>(name: string, schema: Schema.Codec<A, unknown>, gzipped: boolean) => Effect.try({
  try: () => {
    const bytes = readFileSync(`${FIXTURES}${name}`)
    return (gzipped ? gunzipSync(bytes) : bytes).toString("utf8")
  },
  catch: (cause) => new EvaluationError({ code: "unavailable", message: `The review eval's ${name} cannot be read`, cause }),
}).pipe(
  Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text)),
  Effect.mapError((error) => Schema.isSchemaError(error) ? new EvaluationError({ code: "invalid", message: `The review eval's ${name} does not decode: ${error.message}`, cause: error }) : error),
)

/** The known defects (`cases.json`). */
export const goldCases = readFixture("cases.json", GoldCases, false)

/** The recorded draws and the diffs they cite (`recorded.json.gz`). */
export const recorded = readFixture("recorded.json.gz", Recorded, true)

/** What a replay trial is given: the known defect it scores and the review it is in. */
const ReplayInput = Schema.Struct({ gold: GoldId, review: Schema.NonEmptyString })

type ReplayInput = typeof ReplayInput.Type

/** A replay's output as a trial keeps it: `Replayed` with its ids as plain text, since a runnable's output encodes to itself. */
const ReplayOutput = Schema.Struct({ found: Schema.Array(Schema.String), shown: Schema.Array(Schema.String), findings: Schema.Int, kept: Schema.Int })
type ReplayOutput = typeof ReplayOutput.Type

/** A replay keeps no evidence and opens no world. */
const Nothing = Schema.Struct({})
type Nothing = typeof Nothing.Type

const Runnable = runnableExecutionPort<ReplayInput, ReplayOutput, Nothing, Nothing>("review")
const Environment = evaluationEnvironmentPort<ReplayInput, Nothing>("review")

/** The replay of one trial: the candidate's recorded draw (by its id) over the trial's review. */
const replayTrial = (data: Recorded) => Effect.fn("review_eval.replay")(function* (input: ReplayInput, candidate: { readonly id: string }) {
  const draw = data.draws.find((one) => one.id === candidate.id)
  if (draw === undefined) return yield* Effect.fail(new EvaluationError({ code: "invalid", message: `No draw is recorded as ${candidate.id}` }))
  return { output: replayed(draw.findings[input.review] ?? [], data.files[input.review] ?? []), evidence: {} }
})

/**
 * The replay: a candidate is a recorded draw (its id); a trial replays that draw's findings for the trial's review
 * through the reviewer's merge and the report's order (`replayed`), so a change to either moves what it shows. No
 * model is called and nothing is read but the fixtures.
 */
const replay = defineRunnable({
  definition: { id: EvalId.make("replay"), version: "1", description: "a recorded draw's findings through the reviewer's merge and the report's order", fingerprints: {} },
  input: ReplayInput,
  output: ReplayOutput,
  evidence: Nothing,
  runnable: Runnable,
  environment: Environment,
  layer: Layer.effect(Runnable, Effect.map(recorded, (data) => Runnable.of({ execute: replayTrial(data) }))),
  environments: [{ id: "fixtures", layer: Layer.succeed(Environment, Environment.of({ open: () => Effect.succeed({}), inspect: () => Effect.succeed({ state: {}, references: [] }) })) }],
})

/** What the gold grader reads: the known defect the trial scores and the replay's result. */
const GoldInput = Schema.Struct({ gold: GoldId, replay: Replayed })

/** A replay trial's grading context: its task's defect and its output, which is small (a few ids and counts). */
const goldProjection = Layer.succeed(EvidenceProjector, EvidenceProjector.of({
  project: Effect.fn("review_eval.project")(function* (trial: Trial, task: Task) {
    const input = yield* Schema.decodeUnknownEffect(ReplayInput)(task.input).pipe(Effect.mapError((error) => new EvaluationError({ code: "invalid", message: `A replay task's input does not decode: ${error.message}`, cause: error })))
    const output = yield* Option.match(trial.output, {
      onNone: () => Effect.fail(new EvaluationError({ code: "unavailable", message: "The replay gave no output" })),
      onSome: (value) => Schema.decodeUnknownEffect(Replayed)(value).pipe(Effect.mapError((error) => new EvaluationError({ code: "invalid", message: `A replay's output does not decode: ${error.message}`, cause: error }))),
    })
    return yield* gradingContext({ projection: "gold", version: "1", input: { gold: input.gold, replay: output }, schema: GoldInput, budget: { maxBytes: 16_384, reservedBytes: 0 }, references: [trial.id], omissions: [] })
  }),
}))

/**
 * The gold grader, code: `found` when some finding of the replayed review was matched to the task's defect (the
 * recorded judge's match), `shown` when a bucket among the six a review with no check shows holds one.
 */
const goldGrader = Layer.succeed(GraderAssessment, GraderAssessment.of({
  assess: (context) => Schema.decodeUnknownEffect(GoldInput)(context.input).pipe(
    Effect.mapError((error) => new EvaluationError({ code: "invalid", message: `The gold grader's input does not decode: ${error.message}`, cause: error })),
    Effect.map(({ gold, replay }) => {
      const score = goldScore(replay, gold)
      return {
        status: "scored" as const,
        metrics: [{ kind: "boolean" as const, name: "found", value: score.found }, { kind: "boolean" as const, name: "shown", value: score.shown }],
        reason: score.shown ? "printed among the six (of the gold groups' findings: an upper bound)" : score.found ? "found, not printed among the six" : "not found",
        usage: unknownEvaluationUsage,
        metadata: {},
      }
    }),
  ),
}))

/** A known defect as a task of the replay: the defect's id, its pull request as its family, its split. */
const taskOf = (gold: GoldCase): Task => ({
  id: EvalId.make(gold.gold),
  version: "1",
  runnable: "replay",
  dataset: "review-bugs",
  datasetVersion: "1",
  family: `pr-${gold.pr}`,
  split: gold.split,
  review: "provisional",
  input: { gold: gold.gold, review: reviewKeyOf(gold) },
  reference: gold.description,
  graders: [{ grader: "gold@1", projection: "gold", scope: "trial" }],
  provenance: gold.source,
})

/** A blocking gate on the mean of one of the gold grader's metrics over the tasks run. */
const floor = (metric: string, minimum: number) => ({
  grader: "gold@1", metric, aggregate: "mean" as const, mode: "blocking" as const,
  minimum: Option.some(minimum), maximum: Option.none(), requiresReviewedReference: false,
})

/**
 * The review eval as an app of `@xandreed/evals`: one suite, `replay`, over every known defect of the tuning set (the
 * held-out ones have no recording and are not run), each recorded draw a candidate. Its gates are floors at the
 * worse draw's measure on the `tuning` split (found 7/27, shown 4/27): a change to the merge, a bucket's best or the
 * report's order that takes the worse draw under its floor fails, but the better draw may lose up to three shown
 * defects and pass, so the package's tests pin each draw's counts exactly. `found` cannot move without a new
 * recording, and `shown` is over the gold groups' findings alone (a whole review shows the six of every group), an
 * upper bound. A pin of the recorded draws, not the evaluation the package's publication waits on: that runs the
 * reviewer itself.
 */
export const reviewEvalApp: Effect.Effect<EvaluationApp, EvaluationError> = Effect.map(goldCases, (data) => defineEvaluationApp({
  id: "review",
  fingerprints: {},
  commands: {},
  calibrations: [],
  suites: [{
    id: EvalId.make("replay"),
    version: "1",
    purpose: "regression",
    description: "recorded findings through the reviewer's merge and the report's order, scored against the known defects",
    repetitions: 1,
    concurrency: 4,
    timeoutMs: 10_000,
    tasks: data.cases.filter((gold) => gold.split !== "held-out").map(taskOf),
    candidates: [
      { id: EvalId.make("haiku-5.5-high-d1"), configuration: {}, fingerprints: { model: "anthropic/claude-haiku-5.5", prompt: "review-prompt-9", tools: "review-tools-5" } },
      { id: EvalId.make("haiku-5.5-high-d2"), configuration: {}, fingerprints: { model: "anthropic/claude-haiku-5.5", prompt: "review-prompt-9", tools: "review-tools-5" } },
    ],
    gates: [floor("found", 7 / 27 - 1e-9), floor("shown", 4 / 27 - 1e-9)],
  }],
  runnables: [replay],
  environmentFor: { replay: "fixtures" },
  projections: [{ definition: { id: EvalId.make("gold"), version: "1", budget: { maxBytes: 16_384, reservedBytes: 0 } }, layer: goldProjection }],
  graders: [{ definition: { id: EvalId.make("gold"), version: "1", kind: "code", metrics: ["found", "shown"], fingerprints: {} }, layer: goldGrader }],
}))
