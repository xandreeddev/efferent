import { Array as Arr, Clock, Duration, Effect, Match, Option, Schedule, Schema } from "effect"
import { AttemptNumber, RunId } from "../domain/Brands.js"
import type { ImplementorError, WorkspaceError } from "../domain/Errors.js"
import { AcceptedOutcome, AttemptRecord, FactoryRun, RejectedOutcome } from "../domain/FactoryRun.js"
import type { RunOutcome } from "../domain/FactoryRun.js"
import type { Spec } from "../domain/Spec.js"
import type { Workspace } from "../ports/Gate.js"
import { Implementor } from "../ports/Implementor.js"
import { RunSink } from "../ports/RunSink.js"
import { renderFeedback } from "./renderFeedback.js"
import { runPipeline } from "./runPipeline.js"
import type { Pipeline } from "./runPipeline.js"

export interface ForgeOptions<R> {
  readonly spec: Spec
  readonly pipeline: Pipeline<R>
  /** Absolute directory the implementor writes into. */
  readonly workspaceDir: string
  /** Driver-provided snapshot of the workspace the gates judge. */
  readonly snapshot: Effect.Effect<Workspace, WorkspaceError>
}

export interface ForgeResult {
  readonly run: FactoryRun
  /** Where the `RunSink` persisted the artifact. */
  readonly artifact: string
}

type Phase = "continue" | "accepted" | "attempts-exhausted" | "budget-exhausted"

interface LoopState {
  readonly attempt: AttemptNumber
  readonly feedback: Option.Option<string>
  readonly records: ReadonlyArray<AttemptRecord>
  readonly phase: Phase
}

/** Transient implementor failures get 2 quick retries; a third failure is real. */
const implementorRetry = Schedule.exponential(Duration.seconds(1)).pipe(
  Schedule.intersect(Schedule.recurs(2)),
)

const FIRST_ATTEMPT = AttemptNumber.make(1)

/**
 * The factory loop: implement → snapshot → run the gate pipeline → accept, or
 * feed the findings back and try again — bounded by `spec.limits`. State is
 * an immutable fold through `Effect.iterate`: no `let`, no `while`.
 *
 * A rejected run RETURNS (the report is the deliverable); the error channel
 * carries only infrastructure failures. The wall-clock budget is a soft
 * deadline checked at attempt boundaries — the first attempt always
 * completes, and no attempt is interrupted mid-work.
 */
export const forge = <R>(
  options: ForgeOptions<R>,
): Effect.Effect<ForgeResult, ImplementorError | WorkspaceError, R | Implementor | RunSink> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const deadline = startedAt + options.spec.limits.budgetMillis

    const attemptOnce = (state: LoopState): Effect.Effect<LoopState, ImplementorError | WorkspaceError, R | Implementor> =>
      Effect.gen(function* () {
        const implementor = yield* Implementor
        const attemptStart = yield* Clock.currentTimeMillis
        const receipt = yield* implementor
          .implement({
            spec: options.spec,
            attempt: state.attempt,
            feedback: state.feedback,
            workspaceDir: options.workspaceDir,
          })
          .pipe(Effect.retry(implementorRetry))
        const workspace = yield* options.snapshot
        const report = yield* runPipeline(options.pipeline, workspace)
        const attemptEnd = yield* Clock.currentTimeMillis

        const phase: Phase = report.ok
          ? "accepted"
          : state.attempt >= options.spec.limits.maxAttempts
            ? "attempts-exhausted"
            : attemptEnd >= deadline
              ? "budget-exhausted"
              : "continue"
        const feedback =
          phase === "continue"
            ? Option.some(renderFeedback(report, state.attempt))
            : Option.none<string>()

        const record = new AttemptRecord({
          attempt: state.attempt,
          report,
          feedback,
          filesTouched: receipt.filesTouched,
          durationMs: attemptEnd - attemptStart,
        })
        return {
          attempt:
            phase === "continue" ? AttemptNumber.make(state.attempt + 1) : state.attempt,
          feedback,
          records: [...state.records, record],
          phase,
        }
      }).pipe(
        Effect.withSpan("foundry.attempt", { attributes: { "attempt.n": state.attempt } }),
      )

    const final = yield* Effect.iterate(
      {
        attempt: FIRST_ATTEMPT,
        feedback: Option.none<string>(),
        records: [],
        phase: "continue",
      } as LoopState,
      { while: (state) => state.phase === "continue", body: attemptOnce },
    )

    const outcome: RunOutcome = yield* Match.value(final.phase).pipe(
      Match.when("accepted", () =>
        Effect.succeed(AcceptedOutcome.make({ attempt: final.attempt })),
      ),
      Match.when("attempts-exhausted", () =>
        Effect.succeed(RejectedOutcome.make({ reason: "attempts-exhausted" })),
      ),
      Match.when("budget-exhausted", () =>
        Effect.succeed(RejectedOutcome.make({ reason: "budget-exhausted" })),
      ),
      Match.when("continue", () =>
        Effect.dieMessage("unreachable: the iterate loop exited while phase === continue"),
      ),
      Match.exhaustive,
    )

    const records = final.records
    const run = yield* Arr.isNonEmptyReadonlyArray(records)
      ? Effect.map(Clock.currentTimeMillis, (endedAt) =>
          new FactoryRun({
            id: Schema.decodeSync(RunId)(crypto.randomUUID()),
            spec: options.spec,
            attempts: records,
            outcome,
            startedAt,
            endedAt,
          }),
        )
      : Effect.dieMessage("unreachable: the first attempt always records")

    const sink = yield* RunSink
    const artifact = yield* sink.persist(run)
    return { run, artifact }
  }).pipe(Effect.withSpan("foundry.run"))
