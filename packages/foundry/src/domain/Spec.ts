import { Schema } from "effect"

export class ForgeLimits extends Schema.Class<ForgeLimits>("ForgeLimits")({
  /** Attempt ceiling for the forge loop. */
  maxAttempts: Schema.Int.pipe(Schema.between(1, 10)),
  /**
   * Wall-clock budget, checked at attempt boundaries (a soft deadline — the
   * first attempt always completes, mirroring the runtime's step-cap
   * philosophy of never interrupting mid-work).
   */
  budgetMillis: Schema.Positive,
}) {}

/**
 * What to build and how "done" is judged. `goal` + `acceptance` become the
 * implementor's brief; the gates are the mechanical acceptance criteria.
 */
export class Spec extends Schema.Class<Spec>("Spec")({
  goal: Schema.NonEmptyString,
  acceptance: Schema.Array(Schema.NonEmptyString),
  limits: ForgeLimits,
}) {}
