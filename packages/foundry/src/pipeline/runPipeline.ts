import { Array as Arr, Duration, Effect, Match, Option, Order } from "effect"
import { GateName, RuleId } from "../domain/Brands.js"
import { Finding } from "../domain/Finding.js"
import { FailVerdict, GateReport, SkipVerdict, toVerdict } from "../domain/Verdict.js"
import type { GateVerdict } from "../domain/Verdict.js"
import { kindRank } from "../ports/Gate.js"
import type { Gate, Workspace } from "../ports/Gate.js"

/**
 * - `staged` (the default `forge` uses): group gates by cost rank; WITHIN a
 *   rank run all gates (maximize feedback per expensive generation attempt);
 *   ACROSS ranks fail fast (never run tests on code that doesn't typecheck —
 *   their findings would be noise).
 * - `fail-fast` / `collect-all` are the degenerate single-axis policies,
 *   exposed for `foundry check`.
 */
export type PipelinePolicy = "staged" | "fail-fast" | "collect-all"

export interface Pipeline<R> {
  readonly gates: Arr.NonEmptyReadonlyArray<Gate<R>>
  readonly policy: PipelinePolicy
}

const GATE_CRASHED = RuleId.make("foundry/gate-crashed")

/** A gate that could not RUN folds to a `fail` verdict — fail-closed, never
 *  a silent pass (the Verifier's discipline). This is why `runPipeline`'s
 *  error channel is `never`. */
const crashVerdict = (gate: Gate<never>["name"], message: string): GateVerdict =>
  FailVerdict.make({
    gate,
    durationMs: 0,
    findings: [
      new Finding({
        rule: GATE_CRASHED,
        severity: "error",
        message: `gate "${gate}" crashed: ${message}`,
        location: Option.none(),
        fixHint: Option.some("this is a foundry/gate problem, not a workspace problem — fix the gate"),
      }),
    ],
  })

const runGate = <R>(gate: Gate<R>, workspace: Workspace): Effect.Effect<GateVerdict, never, R> =>
  gate.run(workspace).pipe(
    Effect.timed,
    Effect.map(([elapsed, findings]) =>
      toVerdict(gate.name, Duration.toMillis(elapsed), findings),
    ),
    Effect.catchAll((crash) => Effect.succeed(crashVerdict(gate.name, crash.message))),
    Effect.catchAllDefect((defect) => Effect.succeed(crashVerdict(gate.name, String(defect)))),
    Effect.withSpan("foundry.gate", {
      attributes: { "gate.name": gate.name, "gate.kind": gate.kind },
    }),
  )

/** The execution plan: an ordered list of stages (gate groups). */
const stagesFor = <R>(pipeline: Pipeline<R>): ReadonlyArray<Arr.NonEmptyReadonlyArray<Gate<R>>> =>
  Match.value(pipeline.policy).pipe(
    Match.when("staged", () =>
      Arr.groupWith(
        Arr.sortWith(pipeline.gates, (g) => kindRank[g.kind], Order.number),
        (a, b) => kindRank[a.kind] === kindRank[b.kind],
      ),
    ),
    Match.when("fail-fast", () => Arr.map(pipeline.gates, (g) => Arr.of(g))),
    Match.when("collect-all", () => Arr.of(pipeline.gates)),
    Match.exhaustive,
  )

interface Fold {
  readonly verdicts: ReadonlyArray<GateVerdict>
  /** Names of the failed gates in the first failed stage; `None` = still green. */
  readonly blockedBy: Option.Option<ReadonlyArray<GateName>>
}

const skipStage = <R>(
  stage: Arr.NonEmptyReadonlyArray<Gate<R>>,
  blockedBy: ReadonlyArray<GateName>,
): ReadonlyArray<GateVerdict> =>
  Arr.map(stage, (gate) =>
    SkipVerdict.make({
      gate: gate.name,
      reason: `blocked: an earlier stage failed (${blockedBy.join(", ")})`,
    }),
  )

const runStage = <R>(
  stage: Arr.NonEmptyReadonlyArray<Gate<R>>,
  workspace: Workspace,
  fold: Fold,
): Effect.Effect<Fold, never, R> =>
  Effect.forEach(stage, (gate) => runGate(gate, workspace)).pipe(
    Effect.map((verdicts) => {
      const failed = verdicts.filter((v): v is typeof FailVerdict.Type => v._tag === "fail")
      return {
        verdicts: [...fold.verdicts, ...verdicts],
        blockedBy: Arr.isNonEmptyReadonlyArray(failed)
          ? Option.some(Arr.map(failed, (v) => v.gate))
          : Option.none<ReadonlyArray<GateName>>(),
      }
    }),
  )

/**
 * Run every configured gate (or account for it with a `skip`), classify with
 * `toVerdict`, and fold crashes closed. Error channel `never`: a pipeline
 * always produces a report.
 */
export const runPipeline = <R>(
  pipeline: Pipeline<R>,
  workspace: Workspace,
): Effect.Effect<GateReport, never, R> =>
  Effect.reduce(
    stagesFor(pipeline),
    { verdicts: [], blockedBy: Option.none<ReadonlyArray<GateName>>() } as Fold,
    (fold, stage) =>
      Option.match(fold.blockedBy, {
        onNone: () => runStage(stage, workspace, fold),
        onSome: (blockedBy) =>
          Effect.succeed<Fold>({
            verdicts: [...fold.verdicts, ...skipStage(stage, blockedBy)],
            blockedBy: fold.blockedBy,
          }),
      }),
  ).pipe(
    Effect.flatMap((fold) =>
      Arr.isNonEmptyReadonlyArray(fold.verdicts)
        ? Effect.succeed(new GateReport({ verdicts: fold.verdicts }))
        : Effect.dieMessage("unreachable: a non-empty pipeline produced no verdicts"),
    ),
    Effect.withSpan("foundry.pipeline", {
      attributes: { "pipeline.gates": pipeline.gates.length, "pipeline.policy": pipeline.policy },
    }),
  )
