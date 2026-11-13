import { Option, Result } from "effect"
import { CONVERSATION_READER, dataOf, live, messageOf, readerFor, stored, turnStartedEvent } from "@xandreed/core/kernel"
import type { LiveEvent, Message, Reader, Seq, SessionId, StoredDraft, StoredEvent, TurnNumber } from "@xandreed/core/kernel"
import { OverBudget, Tokens } from "../../contracts/memory/memory.entity.js"
import { estimateTokens, messageText } from "../../contracts/memory/memory.entity.functions.js"
import { windowDroppedEvent, windowPressureEvent } from "./window.entity.js"

/** What the window memory reads of a journal: core's records and the conversation's, whose reader it extends, and its own. */
export const WINDOW_READER: Reader = readerFor("window", [windowDroppedEvent], CONVERSATION_READER)

/** `plugin.window.dropped`: every message at or before `through` leaves the window. */
export const windowDropped = (through: Seq): StoredDraft => stored(windowDroppedEvent, { through })

/** Whether a context is at or over `share` of its budget. */
export const nearlyFull = (context: { readonly estimatedTokens: Tokens; readonly budgetTokens: Tokens }, share = 0.8): boolean =>
  context.estimatedTokens >= context.budgetTokens * share

/** `plugin.window.pressure`, about the open turn whose context came close to the budget. */
export const windowPressure = (session: { readonly id: SessionId; readonly turn: TurnNumber }, context: { readonly estimatedTokens: Tokens; readonly budgetTokens: Tokens }): LiveEvent =>
  live(windowPressureEvent, session, { estimatedTokens: context.estimatedTokens, budgetTokens: context.budgetTokens })

/** The messages of one turn: each with its place, and what the turn costs. */
interface WindowTurn {
  readonly messages: ReadonlyArray<{ readonly seq: Seq; readonly message: Message }>
  readonly tokens: number
}

/** What the window decided for one context: its messages and their estimate, and the place up to which it newly dropped, if it dropped. */
export interface Fitted {
  readonly messages: ReadonlyArray<Message>
  readonly estimatedTokens: Tokens
  readonly budgetTokens: Tokens
  readonly dropped: Option.Option<Seq>
}

/**
 * Fit a journal, as `WINDOW_READER` read it, to the budget: every message
 * of the conversation not dropped before, whole turns leaving oldest first
 * while the estimate is over the budget and more than the current turn is
 * left. A turn once dropped stays dropped. The current turn alone over the
 * budget is `OverBudget`. The system text is the caller's: the budget is
 * the history's.
 */
export const fitToBudget = (known: ReadonlyArray<StoredEvent>, budgetTokens: Tokens): Result.Result<Fitted, OverBudget> => {
  const through = known.reduce<number>((last, event) => Option.match(dataOf(windowDroppedEvent, event), { onNone: () => last, onSome: (data) => Math.max(last, data.through) }), 0)
  const turns: Array<{ messages: Array<{ readonly seq: Seq; readonly message: Message }>; tokens: number }> = []
  for (const event of known) {
    if (event.seq <= through) continue
    if (event.name === turnStartedEvent.name) { turns.push({ messages: [], tokens: 0 }); continue }
    const said = messageOf(event)
    if (Option.isNone(said)) continue
    const turn = turns.at(-1) ?? turns[turns.push({ messages: [], tokens: 0 }) - 1]
    if (turn === undefined) continue
    turn.messages.push({ seq: event.seq, message: said.value })
    turn.tokens += estimateTokens(messageText(said.value))
  }
  const kept: ReadonlyArray<WindowTurn> = turns.filter((turn) => turn.messages.length > 0)
  let estimate = kept.reduce<number>((sum, turn) => sum + turn.tokens, 0)
  let first = 0
  while (estimate > budgetTokens && first < kept.length - 1) {
    estimate -= kept[first]?.tokens ?? 0
    first += 1
  }
  const estimatedTokens = Tokens.make(estimate)
  if (estimate > budgetTokens) {
    return Result.fail(new OverBudget({ estimatedTokens, budgetTokens, message: `the current turn is estimated at ${estimate} tokens, over the budget of ${budgetTokens}` }))
  }
  const dropped = first === 0 ? Option.none<Seq>() : Option.fromNullishOr(kept[first - 1]?.messages.at(-1)?.seq)
  return Result.succeed({ messages: kept.slice(first).flatMap((turn) => turn.messages.map((entry) => entry.message)), estimatedTokens, budgetTokens, dropped })
}
