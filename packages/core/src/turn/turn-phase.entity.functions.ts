import { Match, Option, Result } from "effect"
import type { TurnOutcomeKind } from "../domain/turn-vocabulary.entity.js"
import { harnessError } from "../harness/harness-code.entity.functions.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { TurnContextBody } from "../memory/memory-log.entity.js"
import type { TurnPhase } from "./turn-phase.entity.js"

/*
 * The transitions of a turn's phase (`TurnPhase`), pure: `TurnLive` applies
 * one with `Ref.modify`, then runs what it planned (a record, a publish),
 * never inside it, since the bus's subscribers run inline and call back
 * into the phase.
 */

/** What a transition returns, with the phase it moves to; or why the phase refuses it, which leaves the phase as it was. */
export type Transition<A> = Result.Result<readonly [A, TurnPhase], HarnessError>

const moved = <A>(value: A, next: TurnPhase): Transition<A> => Result.succeed([value, next])

const persisted = Result.fail(harnessError("turn.persisted", "The user's message is already persisted"))
const unstarted = (what: string) => Result.fail(harnessError("turn.unstarted", what))

/** Start taking the message (`persistMessage`): only a waiting turn's, so once; `turn.persisted` otherwise. */
export const claim = (phase: TurnPhase): Transition<void> => Match.valueTags(phase, {
  Waiting: ({ early }) => moved(undefined, { _tag: "Taking", early }),
  Taking: () => persisted,
  Taken: () => persisted,
  Replied: () => persisted,
})

/** The message was not recorded: it waits again, with its context entries, to be taken. */
export const release = (phase: TurnPhase): TurnPhase =>
  phase._tag === "Taking" ? { _tag: "Waiting", early: phase.early } : phase

/** The message is recorded as turn `number`: the turn is taken, and the context entries that waited for it are returned, to record next. */
export const take = (number: number) => (phase: TurnPhase): Transition<ReadonlyArray<TurnContextBody>> => Match.valueTags(phase, {
  Waiting: () => unstarted("The user's message is not being persisted"),
  Taking: ({ early }) => moved(early, { _tag: "Taken", number, sectioned: false }),
  Taken: () => persisted,
  Replied: () => persisted,
})

/** A context entry: it waits for the message while the message is not taken, and is returned, to record now, once it is. */
export const addContext = (body: TurnContextBody) => (phase: TurnPhase): Transition<ReadonlyArray<TurnContextBody>> => Match.valueTags(phase, {
  Waiting: ({ early }) => moved([], { _tag: "Waiting", early: [...early, body] }),
  Taking: ({ early }) => moved([], { _tag: "Taking", early: [...early, body] }),
  Taken: () => moved([body], phase),
  Replied: () => moved([body], phase),
})

/** Whether the turn-tier sections are due: once, after the message is taken and before the reply; `turn.unstarted` before. */
export const sectionsDue = (phase: TurnPhase): Transition<boolean> => Match.valueTags(phase, {
  Waiting: () => unstarted("The turn's sections are recorded after the user's message is persisted"),
  Taking: () => unstarted("The turn's sections are recorded after the user's message is persisted"),
  Taken: (taken) => moved(!taken.sectioned, { ...taken, sectioned: true }),
  Replied: () => moved(false, phase),
})

/** The reply, with its outcome: once, after the message is taken, returning the turn's number; none (nothing to record) otherwise. */
export const reply = (outcome: TurnOutcomeKind) => (phase: TurnPhase): Transition<Option.Option<number>> => Match.valueTags(phase, {
  Waiting: () => moved(Option.none(), phase),
  Taking: () => moved(Option.none(), phase),
  Taken: ({ number }) => moved(Option.some(number), { _tag: "Replied", number, outcome }),
  Replied: () => moved(Option.none(), phase),
})

/** The turn's number, once the message is taken. */
export const numberOf = (phase: TurnPhase): Option.Option<number> => Match.valueTags(phase, {
  Waiting: () => Option.none(),
  Taking: () => Option.none(),
  Taken: ({ number }) => Option.some(number),
  Replied: ({ number }) => Option.some(number),
})
