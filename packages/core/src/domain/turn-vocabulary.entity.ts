import { Schema } from "effect"

/*
 * The words a turn is described in, declared once: who began it, how its
 * run came out, how it ended and what failed, and how each step ended.
 * Sessions, memory, the bus, tasks and the step loop take them from here.
 */

const OUTCOMES = ["completed", "partial", "failed"] as const

/**
 * Who began a turn: a user's message, the inbox's pending items, or a
 * background task (the one turn of its child session). A record holding
 * `task` is not read by a release before it.
 */
export const TurnOrigin = Schema.Literals(["user", "inbox", "task"])
export type TurnOrigin = typeof TurnOrigin.Type

/**
 * How a turn's run came out: what `use` returns (`TurnOutcome`), and what its
 * reply and `turn.ended` event carry.
 *
 * @public
 */
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

/**
 * Why a provider's response ended, as effect/ai reports it: whole (`stop`,
 * the model finished; `tool-calls`, it calls tools and waits for their
 * results; `pause`, the provider paused a long reply), or cut short
 * (`length`, the output limit; `content-filter`; `error`; `other`). `unknown`
 * (the provider did not say) cuts short only a response holding tool calls
 * the loop would run, and is whole otherwise (a reply of text alone, or an
 * empty one). A cut response runs none of its tool calls: its step ends
 * `truncated`.
 */
export const FinishReason = Schema.Literals(["stop", "length", "content-filter", "tool-calls", "error", "pause", "other", "unknown"])
export type FinishReason = typeof FinishReason.Type

/**
 * How one step of a run ended (`step.ended`): its call, its tools and its
 * tail done (`completed`), the call failed or something it ran did
 * (`failed`), interrupted (`cancelled`), a response the model could not
 * form (a tool that does not exist, parameters that do not decode), which
 * the loop answers with a corrective turn (`malformed`), or a response cut
 * short (a finish reason but `stop`, `tool-calls` and `pause`, `unknown`
 * only for a response holding tool calls the loop would run), recorded with
 * none of its tool calls run, each answered as cut (`truncated`).
 */
export const StepStatus = Schema.Literals(["completed", "failed", "cancelled", "malformed", "truncated"])
export type StepStatus = typeof StepStatus.Type
