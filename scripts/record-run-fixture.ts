import { Clock, Effect, Layer, Option, Ref, Schema } from "effect"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import {
  EvalId,
  EvaluationError,
  EvaluationRun,
  EvaluationRunStore,
  EvaluationServicesLive,
  GraderAssessment,
  runEvaluation,
  type EvaluationApp,
} from "@xandreed/evals"
import { fixture } from "@xandreed/evals/testing/fixture.testing"

/*
 * Records the evaluation runs the current code stores, for the run
 * compatibility test (`packages/evals/src/run-compat.test.ts`): later
 * releases must still read the reports this release wrote. The recording is
 * deterministic: the evals fixture app, scripted graders and a fixed clock,
 * so it holds no time, path or machine of the recording.
 *
 * It writes `packages/evals/fixtures/run-<version>.json`, the version being
 * the evals package's, with the run as `execution.json` holds it and as
 * `report.json` holds it once graded. It refuses to replace an existing
 * fixture: a fixture is what a released version wrote, so record it once,
 * from that release's code. `--force` rewrites it, only for re-recording the
 * current, unreleased version.
 *
 * Coverage: two candidates, one completed with a transcript and an observed
 * outcome, one failed after its first event; a code grader (boolean) and a
 * model grader (score, probability and preference, with usage); a blocking
 * and a diagnostic gate, passed, outside its threshold and unmeasured.
 */

const root = join(import.meta.dir, "..")
const version = (JSON.parse(await readFile(join(root, "packages/evals/package.json"), "utf8")) as { readonly version: string }).version
const target = join(root, "packages/evals/fixtures", `run-${version}.json`)
if (existsSync(target) && !process.argv.includes("--force")) {
  console.error(`${relative(root, target)} exists: a fixture records what a release wrote. Pass --force to record it again.`)
  process.exit(1)
}

const epoch = 1_767_225_600_000
const realClock = Clock.Clock.defaultValue()
const fixedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => epoch,
  currentTimeMillis: Effect.succeed(epoch),
  currentTimeNanosUnsafe: () => BigInt(epoch) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(epoch) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(epoch) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(BigInt(epoch) * 1_000_000n),
  sleep: (duration) => realClock.sleep(duration),
}

/* ── the app: the fixture app, a failing candidate and a model grader ── */

const base = fixture((input, candidate, _world, recorder) => candidate.id === "broken"
  ? recorder.record("tool.started", { tool: "lookup", query: input }).pipe(
    Effect.andThen(Effect.fail(new EvaluationError({ code: "execution", message: "the lookup service refused" }))))
  : recorder.record("model.request", { body: `answer: ${input}` }).pipe(
    Effect.andThen(recorder.record("tool.completed", { tool: "lookup", result: "source" })),
    Effect.as({ output: "answer", evidence: { facts: ["source"] } })))
const suite = base.suites[0]!
const app: EvaluationApp = {
  ...base,
  fingerprints: { "fixture:world": "1" },
  suites: [{
    ...suite,
    candidates: [...suite.candidates, { id: EvalId.make("broken"), configuration: { model: "fixture" }, fingerprints: { prompt: "1" } }],
    tasks: suite.tasks.map((task) => ({ ...task, graders: [...task.graders, { grader: "judge@1", projection: "projection", scope: "answer" }] })),
    gates: [...suite.gates, {
      grader: "judge@1", metric: "relevance", aggregate: "mean", mode: "diagnostic",
      minimum: Option.some(0.8), maximum: Option.none(), requiresReviewedReference: false,
    }],
  }],
  graders: [...base.graders, {
    definition: { id: EvalId.make("judge"), version: "1", kind: "model", metrics: ["relevance", "confidence", "preferred"], fingerprints: { rubric: "1" } },
    layer: Layer.succeed(GraderAssessment, {
      assess: () => Effect.succeed({
        status: "scored",
        metrics: [
          { kind: "score", name: "relevance", value: 4, min: 1, max: 5, comment: "on topic" },
          { kind: "probability", name: "confidence", value: 0.75 },
          { kind: "preference", name: "preferred", value: "A" },
        ],
        reason: "judged",
        usage: { inputTokens: Option.some(120), outputTokens: Option.some(30), costUsd: Option.none() },
        metadata: { model: "fixture-judge" },
      }),
    }),
  }],
}

/* ── the recording: every run the store is given ── */

const record = Effect.gen(function* () {
  const runs = yield* Ref.make<ReadonlyArray<EvaluationRun>>([])
  const store = Layer.succeed(EvaluationRunStore, {
    writeTrial: () => Effect.void,
    appendTranscript: () => Effect.void,
    writeRun: (run) => Ref.update(runs, (written) => [...written, run]),
  })
  yield* runEvaluation(app, "fixture", { ids: [], split: "validation" }).pipe(
    Effect.provide(EvaluationServicesLive(app)),
    Effect.provide(store),
  )
  return yield* Ref.get(runs)
}).pipe(Effect.provideService(Clock.Clock, fixedClock))

const [execution, report] = await Effect.runPromise(record)
const fixtureFile = {
  format: 1,
  version,
  description: "Evaluation runs as this version stores them, recorded by scripts/record-run-fixture.ts. Later versions must read them.",
  /** The run as `execution.json` holds it. */
  execution: Schema.encodeSync(EvaluationRun)(execution!),
  /** The same run graded, as `report.json` holds it. */
  report: Schema.encodeSync(EvaluationRun)(report!),
}
const text = `${JSON.stringify(fixtureFile, null, 2)}\n`
if (/\/home\/|\/Users\/|[A-Z]:\\\\/.test(text)) {
  console.error("The recording holds an absolute path; nothing was written.")
  process.exit(1)
}
await mkdir(join(target, ".."), { recursive: true })
await writeFile(target, text)
console.log(`Recorded ${report!.trials.length} trials, ${report!.trials.reduce((sum, trial) => sum + trial.transcript.length, 0)} transcript events and ${report!.gates.length} gate findings to ${relative(root, target)}`)
