import { FinishReason } from "@xandreed/core"

/*
 * Whether a provider's response may run: a whole one runs its tool calls; a
 * cut one (its finish reason says it stopped before it was complete) runs
 * none of them. Decided from the response's finish reason, and whether it
 * holds calls the loop would run, before any tool runs.
 */

/**
 * The finish reasons of a whole response: the model finished (`stop`), it
 * calls tools and waits for their results (`tool-calls`), or the provider
 * paused a long reply for its next call to continue (`pause`). The one list
 * of them: every other reason is a `CutReason`.
 */
export const WholeReason = FinishReason.pick(["stop", "tool-calls", "pause"])

/** A finish reason that cuts a response short: every one but the whole ones (`WholeReason`). */
export type CutReason = Exclude<FinishReason, typeof WholeReason.Type>

/**
 * A tool call of a whole response the loop will not run, and so runs none
 * of the response's: a tool the step does not have, or parameters its tool's
 * schema does not decode (with the decoder's report). The loop answers it as
 * a malformed response.
 */
export type MalformedCall =
  | { readonly _tag: "NotFound"; readonly toolName: string }
  | { readonly _tag: "Invalid"; readonly toolName: string; readonly description: string }

/** What a response is worth running: whole (its calls run), or cut short for `reason` (none of them runs). */
export type ResponseVerdict =
  | { readonly _tag: "Whole" }
  | { readonly _tag: "Cut"; readonly reason: CutReason }
