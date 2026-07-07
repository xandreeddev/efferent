import { Schema } from "effect"

/**
 * Branded primitives, per the rubric in `docs/branded-types-roadmap.md`:
 * refined (`Schema.brand` + a filter) where a real invariant exists, plain
 * `Schema.brand` where the goal is confusability protection at a decode
 * boundary. Free-form text (messages, hints, spec goals) is deliberately
 * NOT branded.
 */

/** A quality score. The invariant IS the brand: 0..1, always. */
export const Score = Schema.Number.pipe(Schema.between(0, 1), Schema.brand("Score"))
export type Score = typeof Score.Type

/** `<namespace>/<name>` — e.g. `effect/no-let`, `ts/2322`, `evals/nonempty-scorers`. */
export const RuleId = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/),
  Schema.brand("RuleId"),
)
export type RuleId = typeof RuleId.Type

export const GateName = Schema.NonEmptyString.pipe(Schema.brand("GateName"))
export type GateName = typeof GateName.Type

/** Matches the house id precedent (`ConversationId`, `ContextNodeId`). */
export const RunId = Schema.UUID.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

/** 1-based attempt counter inside a forge run. */
export const AttemptNumber = Schema.Int.pipe(Schema.positive(), Schema.brand("AttemptNumber"))
export type AttemptNumber = typeof AttemptNumber.Type

/**
 * A workspace-RELATIVE path with forward slashes. Minted at exactly two
 * points — the AST walk's node→location conversion and the workspace
 * snapshot — which is what keeps the brand honest.
 */
export const WorkspacePath = Schema.String.pipe(Schema.brand("WorkspacePath"))
export type WorkspacePath = typeof WorkspacePath.Type
