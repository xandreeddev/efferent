import { Schema } from "effect"

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
