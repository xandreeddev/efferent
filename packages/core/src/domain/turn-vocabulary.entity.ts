import { Schema } from "effect"

/*
 * The words a turn is described in, declared once: who began it, how its
 * run came out, how it ended and what failed, and how each step ended.
 * Sessions, memory, the bus, tasks and the step loop take them from here.
 */

const OUTCOMES = ["completed", "partial", "failed"] as const

/** Who began a turn: a user's message, or the inbox's pending items. */
export const TurnOrigin = Schema.Literals(["user", "inbox"])
export type TurnOrigin = typeof TurnOrigin.Type

/** How a turn's run came out: what `use` returns (`TurnOutcome`), and what its reply and `turn.ended` event carry. */
export const TurnOutcomeKind = Schema.Literals(OUTCOMES)
export type TurnOutcomeKind = typeof TurnOutcomeKind.Type

/** Why a turn ended: its run's outcome, or cancelled or interrupted from outside it. */
export const TurnEndReason = Schema.Literals([...OUTCOMES, "cancelled", "interrupted"])
export type TurnEndReason = typeof TurnEndReason.Type

/**
 * What failed: the failing error's code when it has one (`harnessCodeOf`: a
 * `HarnessError`'s, a begin refusal's); otherwise one of the framework's
 * codes, `turn.failed` (a typed error without a code), `turn.defect`,
 * `turn.interrupted` (an interrupted turn or scope), `turn.unended` (a scope
 * closed before its turn ended) or `turn.lease` (a reaped turn), or a code
 * the closer passes to `writer.end` itself (plugin-tasks: `task.turn`,
 * `task.deadline`; a host's own). A task's failure uses the same shape.
 */
export const TurnFailure = Schema.Struct({ code: Schema.String, message: Schema.String })
export type TurnFailure = typeof TurnFailure.Type

/**
 * How a turn ended, as its closer records it (`turnEndingOf` gives the
 * ending of a turn's exit) and the session stores it (`turn.ended`). A
 * cancel carries no failure.
 */
export const TurnEnding = Schema.Struct({ reason: TurnEndReason, failure: Schema.OptionFromNullOr(TurnFailure) })
export type TurnEnding = typeof TurnEnding.Type

/** How one step of a run ended (`step.ended`). */
export const StepStatus = Schema.Literals(["completed", "failed", "cancelled"])
export type StepStatus = typeof StepStatus.Type
