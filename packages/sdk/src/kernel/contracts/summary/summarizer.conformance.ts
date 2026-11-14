import { Cause, Effect, Option } from "effect"
import type { Context, Scope } from "effect"
import { ToolCallId } from "@xandreed/core/kernel"
import type { ConformanceCheck, Message } from "@xandreed/core/kernel"
import { expect, fail, show, unexpected } from "../conformance.entity.functions.js"
import type { Summarizer } from "./summarizer.port.js"

type SummarizerShape = Context.Service.Shape<typeof Summarizer>

/**
 * A summarizer as the kit opens it: a fresh one per check, released with its scope.
 *
 * @public
 */
export interface SummarizerSubject {
  readonly open: Effect.Effect<SummarizerShape, never, Scope.Scope>
}

const call = ToolCallId.make("kit-call")

/** A short conversation to fold: a question, a tool call with its result, and the answer. */
const messages: ReadonlyArray<Message> = [
  { _tag: "User", text: "What is 12 times 3?" },
  { _tag: "Assistant", text: "", toolCalls: [{ id: call, name: "calculator", input: { a: 12, op: "*", b: 3 } }] },
  { _tag: "ToolResult", id: call, name: "calculator", result: 36, isFailure: false },
  { _tag: "Assistant", text: "It is 36.", toolCalls: [] },
]

/**
 * The summarizer contract as a check: asked to fold messages, with no
 * summary so far and with one, it answers with text that is not blank, or
 * fails with `SummaryFailed`; it never answers with nothing, fails with
 * another error or dies (`answers`). A summary memory stores what a
 * summarizer answers, and a stored summary stays: a blank one would stand
 * for the turns it replaced.
 *
 * @public
 */
export const summarizerConformance = (subject: SummarizerSubject): ReadonlyArray<ConformanceCheck> => {
  const asked = (summarizer: SummarizerShape, earlier: Option.Option<string>) => {
    const what = Option.isSome(earlier) ? "a summarizer given an earlier summary" : "a summarizer given no earlier summary"
    return summarizer.summarize({ earlier, messages }).pipe(
      Effect.matchCauseEffect({
        onSuccess: (summary) => expect("answers", summary.trim().length > 0, `${what} answered with nothing: ${show(summary)}`),
        onFailure: (cause) => Option.match(Cause.findErrorOption(cause), {
          onNone: () => fail("answers", `${what} died or was interrupted, where it may only fail with SummaryFailed`),
          onSome: (error) => expect("answers", error._tag === "SummaryFailed", `${what} failed with ${error._tag}, not SummaryFailed`),
        }),
      }),
    )
  }
  return [{
    id: "answers",
    name: "it answers with text that is not blank, or fails with SummaryFailed, with and without an earlier summary",
    run: Effect.scoped(Effect.gen(function* () {
      const summarizer = yield* subject.open
      yield* asked(summarizer, Option.none())
      yield* asked(summarizer, Option.some("The user asked about fibers and scopes."))
    })).pipe(unexpected("answers")),
  }]
}
