import { Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { pageOf } from "../../contracts/memory/pointer.entity.functions.js"
import { READ_RESULT, READ_RESULT_PAGE, ResultPage } from "../../contracts/memory/pointer.entity.js"
import { CurrentTurn } from "../../contracts/turn/current-turn.port.js"
import { SentWhole } from "../../contracts/turn/sent-whole.port.js"

/** What the model sends to read on: the result a pointer named, where to start, and how much. */
const ReadResultParameters = Schema.Struct({
  result: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: "The number a cut-short result gives for itself." }),
  from: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: "The character to start at: the number the cut-short result names, or the `to` of the last part you read." }),
  // A length over the page is not refused: the call reads a page, and `to` says where it stopped.
  length: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({ description: `How many characters to read. A call reads at most ${READ_RESULT_PAGE}, whatever is asked; left out, ${READ_RESULT_PAGE}.` })),
})

/**
 * The tool that reads on from a pointer (ADR 0011): a part of a stored tool result's text, by the place the pointer
 * named. A host that sends pointers (`pointed`) offers it: `Toolkit.make(…, ReadResult)`, with `readResult` as its
 * handler. Its own answers are sent whole (`SentWhole`), and it reaches the journal through its turn (`CurrentTurn`).
 *
 * @public
 */
export const ReadResult = Tool.make(READ_RESULT, {
  description: `Read more of a tool result that was cut short. Returns \`text\`, the characters from \`from\` up to \`to\`, and \`total\`, the result's length: while \`to\` is less than \`total\`, call again with \`from\` set to \`to\`. One call reads at most ${READ_RESULT_PAGE} characters. Use only the numbers a cut-short result names.`,
  parameters: ReadResultParameters,
  success: ResultPage,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [CurrentTurn],
}).annotate(SentWhole, true)

/**
 * What `ReadResult` does when it is called: the part of the stored result the call asks for, read from the journal
 * of the turn it runs in, a page at most whatever length is asked, or a failure the model reads (no tool result at
 * that place; a start past its end).
 *
 * @public
 */
export const readResult = Effect.fn("read_result.read")(function* (params: typeof ReadResultParameters.Type) {
  const turn = yield* CurrentTurn
  return yield* Effect.fromResult(pageOf(yield* turn.journal, params.result, params.from, Math.min(params.length ?? READ_RESULT_PAGE, READ_RESULT_PAGE)))
})
