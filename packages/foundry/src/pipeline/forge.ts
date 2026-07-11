import { Array as Arr, Clock, Duration, Effect, Match, Option, Schedule, Schema } from "effect"
import { AttemptNumber, RunId } from "../domain/Brands.js"
import type { ImplementorError, WorkspaceError } from "../domain/Errors.js"
import {
  AcceptedOutcome,
  AttemptRecord,
  FactoryRun,
  InFlightOutcome,
  RejectedOutcome,
} from "../domain/FactoryRun.js"
import type { RunOutcome } from "../domain/FactoryRun.js"
import type { Spec } from "../domain/Spec.js"
import type { GateReport } from "../domain/Verdict.js"
import type { Workspace } from "../ports/Gate.js"
import { Implementor } from "../ports/Implementor.js"
import type { ImplementReceipt } from "../ports/Implementor.js"
import { RunSink } from "../ports/RunSink.js"
import { renderFeedback } from "./renderFeedback.js"
import { runPipeline } from "./runPipeline.js"
import type { Pipeline } from "./runPipeline.js"

/**
 * Progress seams for a driver UI. All optional; a hook cannot fail (no error
 * channel) and cannot change the loop — it only observes. Fired at the loop's
 * existing boundaries: before an attempt implements, after the implementor
 * returns, after the attempt's gate report (with the feedback that will feed
 * the NEXT attempt, `None` on a final attempt), and after the run persists.
 */
export interface ForgeHooks {
  readonly onAttemptStart?: (attempt: AttemptNumber) => Effect.Effect<void>
  readonly onImplemented?: (
    attempt: AttemptNumber,
    receipt: ImplementReceipt,
  ) => Effect.Effect<void>
  readonly onReport?: (
    attempt: AttemptNumber,
    report: GateReport,
    feedback: Option.Option<string>,
  ) => Effect.Effect<void>
  readonly onOutcome?: (run: FactoryRun) => Effect.Effect<void>
}

export interface ForgeOptions<R> {
  readonly spec: Spec
  readonly pipeline: Pipeline<R>
  /** Absolute directory the implementor writes into. */
  readonly workspaceDir: string
  /** Driver-provided snapshot of the workspace the gates judge. */
  readonly snapshot: Effect.Effect<Workspace, WorkspaceError>
  /** Optional progress observers — see `ForgeHooks`. */
  readonly hooks?: ForgeHooks
}

export interface ForgeResult {
  readonly run: FactoryRun
  /** Where the `RunSink` persisted the artifact. */
  readonly artifact: string
}

type Phase = "continue" | "accepted" | "attempts-exhausted" | "budget-exhausted" | "stalled"

/** A report's identity for the STALL check: the failing findings, sorted.
 *  An attempt that touched NOTHING and reproduced this exact fingerprint
 *  bought no information — retrying again would buy none either (the zig
 *  run burned two attempts this way against an environment-level failure). */
const reportFingerprint = (report: GateReport): string =>
  JSON.stringify(
    report.verdicts
      .flatMap((verdict) =>
        verdict._tag === "skip"
          ? [`skip:${verdict.gate}`]
          : verdict.findings.map((finding) => `${finding.rule}:${finding.message}`),
      )
      .sort(),
  )

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
    // Minted at the START so every mid-run persist upserts the SAME artifact.
    const runId = Schema.decodeSync(RunId)(crypto.randomUUID())
    const sink = yield* RunSink
    const hooks: Required<ForgeHooks> = {
      onAttemptStart: options.hooks?.onAttemptStart ?? (() => Effect.void),
      onImplemented: options.hooks?.onImplemented ?? (() => Effect.void),
      onReport: options.hooks?.onReport ?? (() => Effect.void),
      onOutcome: options.hooks?.onOutcome ?? (() => Effect.void),
    }

    // Attempts land in the artifact AS THEY FINISH: a run killed mid-flight
    // used to leave NO artifact at all — no forensics, and `deriveLessons`
    // learned nothing from the most instructive failures. Best-effort by
    // design (a forensics write must never kill a paid run); the FINAL
    // persist below stays strict.
    const persistPartial = (
      records: ReadonlyArray<AttemptRecord>,
      endedAt: number,
    ): Effect.Effect<void> =>
      Arr.isNonEmptyReadonlyArray(records)
        ? sink
            .persist(
              new FactoryRun({
                id: runId,
                spec: options.spec,
                attempts: records,
                outcome: InFlightOutcome.make({}),
                startedAt,
                endedAt,
              }),
            )
            .pipe(Effect.asVoid, Effect.catchAll(() => Effect.void))
        : Effect.void

    const attemptOnce = (state: LoopState): Effect.Effect<LoopState, ImplementorError | WorkspaceError, R | Implementor> =>
      Effect.gen(function* () {
        const implementor = yield* Implementor
        const attemptStart = yield* Clock.currentTimeMillis
        yield* hooks.onAttemptStart(state.attempt)
        const receipt = yield* implementor
          .implement({
            spec: options.spec,
            attempt: state.attempt,
            feedback: state.feedback,
            workspaceDir: options.workspaceDir,
          })
          .pipe(Effect.retry(implementorRetry))
        yield* hooks.onImplemented(state.attempt, receipt)
        const workspace = yield* options.snapshot
        const report = yield* runPipeline(options.pipeline, workspace)
        const attemptEnd = yield* Clock.currentTimeMillis

        // STALLED: CONFIRMED immobility only — the last TWO attempts changed
        // nothing and the verdict is byte-identical across THREE reports.
        // One no-op repeat is tolerated (a model can pause an attempt, and
        // recurrence-derived lessons need a same-finding repeat — the
        // scripted twin pins that); a second identical no-op buys nothing
        // and never will, so stop and NAME it instead of burning the rest.
        const previous = state.records[state.records.length - 1]
        const prePrevious = state.records[state.records.length - 2]
        const stalled =
          !report.ok &&
          receipt.filesTouched.length === 0 &&
          previous !== undefined &&
          prePrevious !== undefined &&
          previous.filesTouched.length === 0 &&
          reportFingerprint(report) === reportFingerprint(previous.report) &&
          reportFingerprint(previous.report) === reportFingerprint(prePrevious.report)
        const phase: Phase = report.ok
          ? "accepted"
          : stalled
            ? "stalled"
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
          implementorRef: receipt.ref ?? Option.none(),
        })
        yield* hooks.onReport(state.attempt, report, feedback)
        yield* persistPartial([...state.records, record], attemptEnd)
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
      Match.when("stalled", () =>
        Effect.succeed(RejectedOutcome.make({ reason: "stalled" })),
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
            id: runId,
            spec: options.spec,
            attempts: records,
            outcome,
            startedAt,
            endedAt,
          }),
        )
      : Effect.dieMessage("unreachable: the first attempt always records")

    // The strict, authoritative persist — overwrites the in-flight marker.
    const artifact = yield* sink.persist(run)
    yield* hooks.onOutcome(run)
    return { run, artifact }
  }).pipe(Effect.withSpan("foundry.run"))
