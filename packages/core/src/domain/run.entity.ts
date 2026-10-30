import { Effect, Schema } from "effect"

/**
 * Names the run of one turn, as the host begins it (`NewTurn.runId`): memory
 * numbers the turn's entries `<runId>:<n>` from it, and its requests, tool
 * calls and `turn.*` events carry it. A session refuses a run id it saw
 * before (`RunIdReused`), so every begin mints a new one
 * (`RunId.make(crypto.randomUUID())`). Read back as stored, with no checks.
 */
export const RunId = Schema.String.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

/**
 * Names one tool call of a run, `<runId>:call:<n>` as the tool registry
 * mints it: it pairs the call's `tool.started`, `tool.progress` and
 * `tool.completed`, or names its `tool.refused`.
 */
export const InvocationId = Schema.String.pipe(Schema.brand("InvocationId"))
export type InvocationId = typeof InvocationId.Type

/**
 * Which run of the step loop within one turn: the turn's first run is 0,
 * and each later `Turn.run` counts one up (`TurnMemory.startRun`). Every
 * run of a turn shares its `RunId`; the ordinal tells their steps apart.
 */
export const RunOrdinal = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand("RunOrdinal"))
export type RunOrdinal = typeof RunOrdinal.Type

/**
 * A run's ordinal as stored, on a request header, a render recipe, a step
 * context and the step events: a record written before runs were counted
 * has none, and reads 0.
 */
export const RunKey = RunOrdinal.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0)))

/** One run of the step loop: the turn's run id, the turn's number, and the run's ordinal within the turn. */
export const RunRef = Schema.Struct({ id: RunId, turn: Schema.Int, ordinal: RunOrdinal })
export type RunRef = typeof RunRef.Type
