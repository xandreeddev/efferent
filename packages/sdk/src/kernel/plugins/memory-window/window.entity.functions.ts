import { Option, Predicate, Result } from "effect"
import { dataOf, estimateTokens, live, originOf, readerFor, stored, Tokens, turnStartedEvent } from "@xandreed/core/kernel"
import type { Delivered, LiveEvent, ModelRequest, Reader, SentRequest, Seq, StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import { OverBudget, windowDroppedEvent, windowPressureEvent } from "./window.entity.js"

/** What the window memory reads of a journal: the session and loop records, and its own. */
export const WINDOW_READER: Reader = readerFor("window", [windowDroppedEvent])

/**
 * Whether an error is the window memory's `OverBudget`, whichever copy of the plugin raised it.
 *
 * @public
 */
export const isOverBudget = (error: unknown): error is OverBudget => Predicate.isTagged(error, "OverBudget")

/** `plugin.window.dropped`: every message at or before `through` leaves the window. */
export const windowDropped = (through: Seq): StoredDraft => stored(windowDroppedEvent, { through })

/** Whether a sent request is at or over `share` of its budget. */
export const nearlyFull = (request: { readonly estimatedTokens: Tokens; readonly budgetTokens: Tokens }, share = 0.8): boolean =>
  request.estimatedTokens >= request.budgetTokens * share

/** `plugin.window.pressure`, about the request that came close to the budget. */
export const windowPressure = (sent: Delivered<SentRequest>): LiveEvent =>
  live(windowPressureEvent, originOf(sent), { estimatedTokens: sent.data.estimatedTokens, budgetTokens: sent.data.budgetTokens })

/** The messages of one turn: where each is, and what the turn costs. */
interface WindowTurn {
  readonly messages: ReadonlyArray<Seq>
  readonly tokens: number
}

/** What the window decided for one request: the request, and the place up to which it newly dropped, if it dropped. */
export interface Fitted {
  readonly request: ModelRequest
  readonly dropped: Option.Option<Seq>
}

/**
 * Fit a journal, as `WINDOW_READER` read it, to the budget: every message
 * not dropped before, whole turns leaving oldest first while the estimate
 * is over the budget and more than the current turn is left. A turn once
 * dropped stays dropped. The current turn alone over the budget is
 * `OverBudget`.
 */
export const fitToBudget = (system: string, known: ReadonlyArray<StoredEvent>, budgetTokens: Tokens): Result.Result<Fitted, OverBudget> => {
  const through = known.reduce<number>((last, event) => Option.match(dataOf(windowDroppedEvent, event), { onNone: () => last, onSome: (data) => Math.max(last, data.through) }), 0)
  const turns: Array<{ messages: Array<Seq>; tokens: number }> = []
  for (const event of known) {
    if (event.seq <= through) continue
    if (event.name === turnStartedEvent.name) turns.push({ messages: [], tokens: 0 })
    else if (event.message !== undefined) {
      const turn = turns.at(-1) ?? turns[turns.push({ messages: [], tokens: 0 }) - 1]
      if (turn === undefined) continue
      turn.messages.push(event.seq)
      turn.tokens += estimateTokens(event.message.text)
    }
  }
  const kept: ReadonlyArray<WindowTurn> = turns.filter((turn) => turn.messages.length > 0)
  let estimate = kept.reduce<number>((sum, turn) => sum + turn.tokens, estimateTokens(system))
  let first = 0
  while (estimate > budgetTokens && first < kept.length - 1) {
    estimate -= kept[first]?.tokens ?? 0
    first += 1
  }
  const estimatedTokens = Tokens.make(estimate)
  if (estimate > budgetTokens) {
    return Result.fail(new OverBudget({ estimatedTokens, budgetTokens, message: `the current turn is estimated at ${estimate} tokens, over the budget of ${budgetTokens}` }))
  }
  const dropped = first === 0 ? Option.none<Seq>() : Option.fromNullishOr(kept[first - 1]?.messages.at(-1))
  return Result.succeed({ request: { messages: kept.slice(first).flatMap((turn) => turn.messages), estimatedTokens, budgetTokens }, dropped })
}
