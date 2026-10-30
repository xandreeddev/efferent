import type { Tool } from "effect/ai"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { hostNote } from "@xandreed/core"
import type { Failure, FinishReason } from "@xandreed/core"
import { WholeReason } from "./response-gate.entity.js"
import type { CutReason, MalformedCall, ResponseVerdict } from "./response-gate.entity.js"

const isWhole = Schema.is(WholeReason)

/**
 * The gate: a response whose finish reason cuts it short runs none of its
 * tool calls. `unknown` (the provider gave no finish reason) cuts a response
 * only when it holds calls the loop would run (`callsToRun`): a reply in
 * text, or an empty one, without a finish completes as a whole one does.
 */
export const verdictOf = (reason: FinishReason, callsToRun: boolean): ResponseVerdict =>
  isWhole(reason) || (reason === "unknown" && !callsToRun) ? { _tag: "Whole" } : { _tag: "Cut", reason }

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

/** The step's tool of that name, its own key only: `constructor` or `toString` names no tool. */
const toolNamed = (tools: Readonly<Record<string, Tool.Any>>, name: string): Option.Option<Tool.Any> =>
  Object.hasOwn(tools, name) ? Option.fromNullishOr(tools[name]) : Option.none()

/**
 * The first of a whole response's tool calls the loop will not run: a tool
 * the step does not have, or parameters its tool's schema does not decode.
 * None of the calls runs until every one passes (the loop answers the first
 * that does not as a malformed response). A tool whose parameters are not a
 * Schema (a JSON Schema the toolkit passes through) checks its own. The
 * parameters decode as the toolkit decodes them, in an Effect with the
 * caller's services: a schema that decodes asynchronously, or through a
 * service, is checked like any other.
 */
export const malformedCall = (
  calls: ReadonlyArray<{ readonly name: string; readonly params: unknown }>,
  tools: Readonly<Record<string, Tool.Any>>,
): Effect.Effect<Option.Option<MalformedCall>> => Effect.forEach(calls, (call): Effect.Effect<Option.Option<MalformedCall>> => Option.match(toolNamed(tools, call.name), {
  onNone: () => Effect.succeed(Option.some({ _tag: "NotFound", toolName: call.name })),
  onSome: (tool) => Option.match(Option.liftPredicate(tool.parametersSchema, Schema.isSchema), {
    onNone: () => Effect.succeedNone,
    onSome: (parameters) => Schema.decodeUnknownEffect(parameters as Schema.Decoder<unknown>)(call.params).pipe(Effect.match({
      onSuccess: () => Option.none(),
      onFailure: (error) => Option.some({ _tag: "Invalid", toolName: call.name, description: error.message }),
    })),
  }),
}), { concurrency: 1 }).pipe(Effect.map((checked) => Arr.findFirst(checked, (found) => found)))
