import { Effect, Match, Option, Predicate, Schema } from "effect"
import { clipTo, framed, hostNote } from "@xandreed/core"
import type { Failure, FinishReason, PreparedToolCall, PreparedToolHandler } from "@xandreed/core"
import { WholeReason } from "./response-gate.entity.js"
import type { CutReason, MalformedCall, RejectedCall, ResponseVerdict } from "./response-gate.entity.js"

const isWhole = Schema.is(WholeReason)

/** The loop's own failure description, distinguished from provider decoder reports. */
export const DUPLICATE_CALL_IDS = "multiple tool calls have the same pairing id"

/** No call with an ambiguous pairing key ran. */
export const duplicateCallCorrective = (tools: ReadonlyArray<string>): string => hostNote(`your previous reply reused one id for multiple tool calls, so none ran. Reply again with a separate call for each action.${tools.length === 0 ? "" : ` The tools you can call are: ${tools.join(", ")}.`}`)

/**
 * The gate: a response whose finish reason cuts it short runs none of its
 * tool calls. `unknown` (the provider gave no finish reason) cuts a response
 * only when it holds calls the loop would run (`callsToRun`): a reply in
 * text, or an empty one, without a finish completes as a whole one does.
 */
export const verdictOf = (reason: FinishReason, callsToRun: boolean): ResponseVerdict =>
  isWhole(reason) || (reason === "unknown" && !callsToRun) ? { _tag: "Whole" } : { _tag: "Cut", reason }

/** A whole response's call as the gate checked it: why the loop will not run it, or the call prepared to run. */
export interface CheckedCall {
  readonly rejection: Option.Option<MalformedCall>
  readonly prepared: Option.Option<PreparedToolCall>
}

/**
 * Each of a whole response's tool calls checked and prepared, in call order:
 * a call whose id an earlier call of the response has is a `DuplicateId`; one
 * naming no tool the step has (`tools`' own keys only, so `constructor` or
 * `toString` names none) is `NotFound`; otherwise `execution` prepares it,
 * decoding its parameters once (a JSON Schema tool's pass through), and one
 * that does not prepare is `Invalid` with the decoder's report. Preparation
 * starts no handler, so every call is checked before any runs.
 */
export const checkCalls = (
  calls: ReadonlyArray<{ readonly id?: string | undefined; readonly name: string; readonly params: unknown }>,
  tools: Readonly<Record<string, unknown>>,
  execution: PreparedToolHandler,
): Effect.Effect<ReadonlyArray<CheckedCall>> => Effect.forEach(calls, (call, index): Effect.Effect<CheckedCall> => {
  if (call.id !== undefined && calls.slice(0, index).some((earlier) => earlier.id === call.id)) return Effect.succeed({ rejection: Option.some({ _tag: "DuplicateId", toolName: call.name }), prepared: Option.none() })
  if (!Object.hasOwn(tools, call.name)) return Effect.succeed({ rejection: Option.some({ _tag: "NotFound", toolName: call.name }), prepared: Option.none() })
  return execution.prepare(call.name, call.params).pipe(Effect.match({
    onSuccess: (prepared): CheckedCall => ({ rejection: Option.none(), prepared: Option.some(prepared) }),
    onFailure: (error): CheckedCall => ({
      rejection: Option.some({ _tag: "Invalid", toolName: call.name, description: Predicate.hasProperty(error.reason, "description") && typeof error.reason.description === "string" ? error.reason.description : error.message }),
      prepared: Option.none(),
    }),
  }))
}, { concurrency: 1 })

/** How a cut reply ended, in words: the model reads them in each of its calls' results, the host in the run's failure. */
const cutWords: Readonly<Record<CutReason, string>> = {
  length: "reached the output limit",
  "content-filter": "was stopped by the provider's content filter",
  error: "was cut off by an error at the provider",
  other: "was cut short for a reason the provider did not name",
  unknown: "ended before the provider said it was complete",
}

/** What each tool call of a cut reply is answered with: it did not run. */
export const replyCutFailure = (reason: CutReason): Failure => ({
  error: "ReplyCut",
  message: `Your reply ${cutWords[reason]}, so this call was not run. Call it again if you still need it.`,
})

/** Consecutive replies cut at the output limit the loop answers with a corrective; the next one fails the run (`loop.truncated`). */
export const MAX_CUT_CORRECTIVES = 2

/**
 * The loop's own note after a reply cut at the output limit, by whether it
 * held calls the loop would have run (`callsToRun`; a provider-executed one
 * is the provider's): what was lost, and how to reply so it is not cut again.
 */
export const lengthCorrective = (callsToRun: boolean): string => hostNote(callsToRun
  ? "your previous reply reached the output limit and was cut short, so the tool calls it made were not run: their results say so. Call the tools you still need again, fewer in one reply and with less text before them."
  : "your previous reply reached the output limit and was cut short. Continue from where it stopped, in replies short enough to finish.")

/** Why the run stops at a cut it does not correct: a cut other than the output limit, or one past the correctives. */
export const truncatedMessage = (reason: CutReason, step: number, cutsInARow: number): string => reason === "length"
  ? `the model's replies reached the output limit ${cutsInARow} times in a row, the last at step ${step}, after ${MAX_CUT_CORRECTIVES} correctives`
  : `the model's reply at step ${step} ${cutWords[reason]}`

/** Whether the loop can answer a call alone (`RejectedCall`), not only by answering its whole response as malformed. */
export const isRejectedCall = (call: MalformedCall): call is RejectedCall => call._tag !== "DuplicateId"

/** The longest tool name or decoder report the loop quotes back to the model, in a corrective or a rejected call's answer. */
export const QUOTE_CHARS = 600

/**
 * What a whole reply's call the loop answers instead of running is answered
 * with, under `invalidCalls: "answer"`: it was not run, why, and, for a tool
 * the step does not have, the tools it can call; then what the model wrote,
 * framed as data and clipped (the name it gave, or the decoder's report on
 * its parameters, which may quote them).
 */
export const rejectedCallFailure = (call: RejectedCall, tools: ReadonlyArray<string>): Failure => Match.valueTags(call, {
  NotFound: (missing): Failure => ({
    error: "ToolNotFound",
    message: `This call was not run: it names a tool you do not have; the name follows, as you wrote it. ${tools.length === 0 ? "You can call no tools now." : `The tools you can call are: ${tools.join(", ")}.`}\n\n${framed("tool-name", clipTo(missing.toolName, QUOTE_CHARS))}`,
  }),
  Invalid: (invalid): Failure => ({
    error: "InvalidParameters",
    message: `This call was not run: its parameters do not match the schema of ${invalid.toolName}; what did not match follows, and it may quote your call. Call ${invalid.toolName} again with its parameters as its schema gives them if you still need it.\n\n${framed("parameter-errors", clipTo(invalid.description, QUOTE_CHARS))}`,
  }),
})
