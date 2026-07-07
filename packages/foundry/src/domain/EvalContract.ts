import type { Effect } from "effect"
import { Schema } from "effect"
import type { Array as Arr } from "effect"
import { Score } from "./Brands.js"

/**
 * The evals v2 contract — the type-level fix for the v1 holes: a suite with
 * `scorers: []` no longer typechecks, `threshold` is required and branded
 * 0..1, and scorers can finally SEE the trajectory (the run's tool-call
 * path), not just the final output. `packages/evals` migrates onto this;
 * the `eval-shape` gate enforces the parts types can't (registration,
 * explicit thresholds in source).
 */

/** One step of the agent's path — what trajectory scorers judge. */
export class TrajectoryStep extends Schema.Class<TrajectoryStep>("TrajectoryStep")({
  tool: Schema.NonEmptyString,
  argsSummary: Schema.optionalWith(Schema.String, { as: "Option" }),
  ok: Schema.Boolean,
}) {}

export interface EvalCaseV2<I, T> {
  readonly name: string
  readonly input: I
  readonly expected: T
  readonly tags?: ReadonlyArray<string>
}

export interface ScorerArgsV2<I, O, T> {
  readonly input: I
  readonly output: O
  readonly expected: T
  readonly trajectory: ReadonlyArray<TrajectoryStep>
}

export interface ScorerV2<I, O, T, E = never, R = never> {
  readonly name: string
  readonly score: (args: ScorerArgsV2<I, O, T>) => Effect.Effect<Score, E, R>
}

export interface EvalSpecV2<I, O, T, R> {
  readonly name: string
  readonly description?: string
  readonly data: ReadonlyArray<EvalCaseV2<I, T>>
  readonly task: (
    input: I,
    kase: EvalCaseV2<I, T>,
  ) => Effect.Effect<{ readonly output: O; readonly trajectory: ReadonlyArray<TrajectoryStep> }, unknown, R>
  /** `[]` is a type error — a suite MUST judge something. */
  readonly scorers: Arr.NonEmptyReadonlyArray<ScorerV2<I, O, T, unknown, R>>
  /** Required and branded — no decorative thresholds, no hardcoded gate. */
  readonly threshold: Score
  readonly samples?: number
}

/** Identity pin, mirroring v1's `defineEval` — the definition site is where
 *  the generics (and the non-empty scorers requirement) lock in. */
export const defineEvalV2 = <I, O, T, R>(spec: EvalSpecV2<I, O, T, R>): EvalSpecV2<I, O, T, R> =>
  spec
