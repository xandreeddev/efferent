import { Option } from "effect"
import { CONVERSATION_READER, dataOf, messageOf, readerFor, stored } from "@xandreed/core/kernel"
import type { Message, Reader, Seq, StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import { Tokens } from "../../contracts/memory/memory.entity.js"
import { estimateTokens, messageText } from "../../contracts/memory/memory.entity.functions.js"
import { summarizedEvent } from "./summary.entity.js"

/** What the summary memory reads of a journal: the conversation's records, whose reader it extends, and its own. */
export const SUMMARY_READER: Reader = readerFor("summary", [summarizedEvent], CONVERSATION_READER)

const NOTE_START = "[Host note: earlier turns of this conversation, in short: "
const NOTE_END = "]"

/** The summary as the model reads it: a host note, sent first, in place of the turns it replaces. */
export const summaryNote = (summary: string): string => `${NOTE_START}${summary}${NOTE_END}`

/** The summary a note holds. */
const summaryOf = (note: string): string =>
  note.startsWith(NOTE_START) && note.endsWith(NOTE_END) ? note.slice(NOTE_START.length, note.length - NOTE_END.length) : note

/** `plugin.summary.summarized`: the turns up to `through` replaced by `summary`, held once, as the record's message. */
export const summarized = (through: Seq, summary: string): StoredDraft =>
  stored(summarizedEvent, { through }, { message: { _tag: "User", text: summaryNote(summary) } })

/** One turn of the conversation as the memory weighs it: its number, its messages with their places, its cost. */
interface Turn {
  readonly turn: number
  readonly messages: ReadonlyArray<{ readonly seq: Seq; readonly message: Message }>
  readonly tokens: number
}

/** What the memory decided for one context. */
export type Plan =
  /** The context fits: the summary's note, if there is one, then every message after it. */
  | { readonly _tag: "Fits"; readonly messages: ReadonlyArray<Message>; readonly estimatedTokens: Tokens }
  /** Over the budget: fold these messages, with the summary so far, into a new summary up to `through`. */
  | { readonly _tag: "Fold"; readonly earlier: Option.Option<string>; readonly fold: ReadonlyArray<Message>; readonly through: Seq; readonly estimatedTokens: Tokens }
  /** Over the budget with nothing left to fold: the open turn alone does not fit. */
  | { readonly _tag: "Over"; readonly estimatedTokens: Tokens }

/**
 * Plan a context from a journal as `SUMMARY_READER` read it: the latest summary's note, then every message after it,
 * when that fits the budget. When it does not, fold the oldest closed turns, keeping `keepTurns` of the latest closed
 * turns whole if that still fits once the summary's note is counted at its present size (before the first summary, its
 * frame alone), and folding them too when it does not. The open turn is never folded, and whole turns only, so a tool call stays with its result.
 */
export const plan = (known: ReadonlyArray<StoredEvent>, openTurn: number, budgetTokens: Tokens, keepTurns: number): Plan => {
  const latest = known.reduceRight<Option.Option<{ readonly through: Seq; readonly note: string }>>(
    (found, event) => Option.isSome(found) ? found : Option.flatMap(dataOf(summarizedEvent, event), (data) =>
      Option.map(Option.fromNullishOr(event.message), (message) => ({ through: data.through, note: messageText(message) }))),
    Option.none(),
  )
  const through = Option.match(latest, { onNone: () => 0, onSome: (summary) => summary.through })
  const note: ReadonlyArray<Message> = Option.match(latest, { onNone: () => [], onSome: (summary) => [{ _tag: "User", text: summary.note }] })
  const noteTokens = note.reduce((sum, message) => sum + estimateTokens(messageText(message)), 0)

  const turns: Array<{ turn: number; messages: Array<{ readonly seq: Seq; readonly message: Message }>; tokens: number }> = []
  for (const event of known) {
    if (event.seq <= through) continue
    const said = messageOf(event)
    if (Option.isNone(said)) continue
    const last = turns.at(-1)
    const turn = last !== undefined && last.turn === event.turn ? last : turns[turns.push({ turn: event.turn, messages: [], tokens: 0 }) - 1]!
    turn.messages.push({ seq: event.seq, message: said.value })
    turn.tokens += estimateTokens(messageText(said.value))
  }
  const all: ReadonlyArray<Turn> = turns
  const cost = (kept: ReadonlyArray<Turn>) => kept.reduce((sum, turn) => sum + turn.tokens, 0)
  const total = noteTokens + cost(all)
  if (total <= budgetTokens) {
    return { _tag: "Fits", messages: [...note, ...all.flatMap((turn) => turn.messages.map((entry) => entry.message))], estimatedTokens: Tokens.make(total) }
  }
  const closed = all.filter((turn) => turn.turn < openTurn)
  if (closed.length === 0) return { _tag: "Over", estimatedTokens: Tokens.make(total) }
  // Fold the oldest closed turns until the rest fits beside a note of the present size; keep `keepTurns` if that is enough.
  const keep = Math.max(0, Math.min(keepTurns, closed.length))
  const reserve = Option.isSome(latest) ? noteTokens : estimateTokens(summaryNote(""))
  const fits = (folded: number) => reserve + cost(all.slice(folded)) <= budgetTokens
  // At least one turn; the fewest that fit while the latest `keep` closed turns stay whole; then more, if they must.
  let folded = 1
  while (folded < closed.length - keep && !fits(folded)) folded += 1
  while (folded < closed.length && !fits(folded)) folded += 1
  const fold = closed.slice(0, folded)
  const last = fold.at(-1)?.messages.at(-1)?.seq
  if (last === undefined) return { _tag: "Over", estimatedTokens: Tokens.make(total) }
  return {
    _tag: "Fold",
    earlier: Option.map(latest, (summary) => summaryOf(summary.note)),
    fold: fold.flatMap((turn) => turn.messages.map((entry) => entry.message)),
    through: last,
    estimatedTokens: Tokens.make(total),
  }
}
