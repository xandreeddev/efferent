import { Option } from "effect"
import { clipTo } from "../memory/memory.entity.functions.js"
import type { CallRead, ResultRead, TurnRead } from "../turn/turns.entity.js"
import { CONTEXT_LIMIT, SOURCE_LIMIT, TURN_MESSAGE_SHOWN, TURN_RESULT_SHOWN } from "./knowledge.entity.js"
import type { SaidBy, SourcePart, TurnSource, TurnSourceOptions } from "./knowledge.entity.js"
import { partText, sourceText } from "./knowledge.entity.functions.js"

/** A part of a source, unless its text is blank: a part says something. */
const part = (by: SaidBy, text: string): ReadonlyArray<SourcePart> => (text.trim().length === 0 ? [] : [{ by, text }])

/**
 * A tool call with what it came to, as a source's part: what it returned as the part's text, and the call beside
 * it (its name and its parameters as JSON, and whether it failed), each of the two cut at `TURN_RESULT_SHOWN`.
 */
const toolPart = (call: CallRead, result: ResultRead): SourcePart => ({
  by: "tool",
  text: clipTo(typeof result.result === "string" ? result.result : JSON.stringify(result.result) ?? "", TURN_RESULT_SHOWN),
  call: { text: `${call.name}, called with ${clipTo(JSON.stringify(call.input) ?? "", TURN_RESULT_SHOWN)}`, failed: result.isFailure },
})

/** The most characters of one message or answer in a source's context. */
const CONTEXT_PART = 900

/** The shortest a user's message is cut to before whole messages are left out. */
const SHORTEST = 125

/** The turns before a source, as its context: each one's messages from the person and its final answer, labelled as a source's parts are. */
const contextOf = (before: ReadonlyArray<TurnRead>): string =>
  clipTo(before.flatMap((turn) => [
    ...turn.messages.filter((message) => message.from === undefined).flatMap((message) => part("user", clipTo(message.text, CONTEXT_PART))),
    ...Option.match(turn.answer, { onNone: () => [], onSome: (answer) => part("assistant", clipTo(answer, CONTEXT_PART)) }),
  ]).map(partText).join("\n"), CONTEXT_LIMIT)

/**
 * One turn of a conversation as a source a curator reads (ADR 0022), from the turns `turnsOf` gives. `at` is the
 * turn's number; none when no such turn is among them, or when the person said nothing in it (a turn that holds
 * only a background task's report is no source).
 *
 * The parts, in the order their records were stored: each message of the person's (`user`); each tool call that
 * has a result (`tool`: the result as the part's text, with its call beside it, so it reads
 * `<name>, called with <json>, returned: <text>`, or `failed:` for a failed result), but those of the tools
 * `options.leave` names; then the turn's final answer (`assistant`), when it has one. A message
 * another session sent (a task's report) is left out.
 *
 * Each part is bounded on its own, with a marker that counts what was cut, so one long tool result never cuts the
 * person's words or the answer off: a tool call's parameters and its result to `TURN_RESULT_SHOWN` characters each,
 * a message and the answer to `TURN_MESSAGE_SHOWN` each. While the whole is still over `SOURCE_LIMIT`, tool calls are left out, the oldest
 * first; with none left, the person's messages are cut shorter, by half each time, and then left out, the oldest
 * first.
 *
 * The context is the two turns before it in the list: the person's messages and the final answers only.
 *
 * @public
 */
export const turnSource = (turns: ReadonlyArray<TurnRead>, at: number, options: TurnSourceOptions = {}): Option.Option<TurnSource> => {
  const index = turns.findIndex((turn) => turn.turn === at)
  const turn = turns[index]
  if (turn === undefined) return Option.none()
  const leave = new Set(options.leave ?? [])
  const messages = turn.messages.filter((message) => message.from === undefined && message.text.trim().length > 0)
  const users = (bound: number, from: number): ReadonlyArray<{ readonly seq: number; readonly part: SourcePart }> =>
    messages.slice(from).flatMap((message) => part("user", clipTo(message.text, bound)).map((one) => ({ seq: message.seq, part: one })))
  const tools = turn.steps.flatMap((step) => step.calls).filter((call) => !leave.has(call.name)).flatMap((call) =>
    Option.match(call.result, { onNone: () => [], onSome: (result) => [{ seq: result.seq, part: toolPart(call, result) }] }))
  const answer = Option.match(turn.answer, { onNone: () => [], onSome: (text) => part("assistant", clipTo(text, TURN_MESSAGE_SHOWN)) })
  const built = (bound: number, from: number, dropped: number): ReadonlyArray<SourcePart> =>
    [...[...users(bound, from), ...tools.slice(dropped)].toSorted((a, b) => a.seq - b.seq).map((one) => one.part), ...answer]
  let bound = TURN_MESSAGE_SHOWN
  let from = 0
  let dropped = 0
  while (sourceText({ said: built(bound, from, dropped) }).length > SOURCE_LIMIT) {
    if (dropped < tools.length) dropped++
    else if (bound > SHORTEST) bound = Math.max(SHORTEST, Math.floor(bound / 2))
    else if (from < messages.length - 1) from++
    else break
  }
  const said = built(bound, from, dropped)
  const [first, ...rest] = said
  if (first === undefined || users(bound, from).length === 0) return Option.none()
  return Option.some({ text: sourceText({ said }), context: contextOf(turns.slice(Math.max(0, index - 2), index)), said: [first, ...rest] })
}
