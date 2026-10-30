import { Match, Option, Result } from "effect"
import { RunOrdinal } from "../domain/run.entity.js"
import type { RunId, RunRef } from "../domain/run.entity.js"
import type { TurnOutcomeKind } from "../domain/turn-vocabulary.entity.js"
import { harnessError } from "../harness/harness-code.entity.functions.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { LogEntry, TurnContextBody } from "../memory/memory-log.entity.js"
import type { ReplyStep, TurnPhase } from "./turn-phase.entity.js"

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
  Taking: ({ early }) => moved(early, { _tag: "Taken", number, sectioned: false, runs: RunOrdinal.make(0) }),
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

/**
 * A run of the step loop starts (`TurnMemory.startRun`): the turn's next
 * run, under the turn's run id and number, its ordinal counting from 0.
 * `turn.unstarted` before the message is taken; `turn.closed` once the
 * reply is recorded, which ends the turn's runs.
 */
export const startRun = (id: RunId) => (phase: TurnPhase): Transition<RunRef> => Match.valueTags(phase, {
  Waiting: () => unstarted("A run starts after the user's message is persisted"),
  Taking: () => unstarted("A run starts after the user's message is persisted"),
  Taken: (taken) => moved({ id, turn: taken.number, ordinal: taken.runs }, { ...taken, runs: RunOrdinal.make(taken.runs + 1) }),
  Replied: () => Result.fail(harnessError("turn.closed", "The turn's reply is recorded: no run starts after it")),
})

const nothing: ReplyStep = { _tag: "Nothing" }

const isReply = (entry: LogEntry): boolean => entry.body._tag === "TurnEnded"

/** The held entries with the reply's outcome failed, its id and text kept. */
const downgraded = (held: ReadonlyArray<LogEntry>): ReadonlyArray<LogEntry> =>
  held.map((entry): LogEntry => entry.body._tag === "TurnEnded" ? { ...entry, body: { ...entry.body, outcome: "failed" } } : entry)

/** A failed reply after a completed or partial one: its held entries again, the reply failed; recorded again when memory never held it. */
const downgrade = (replied: Extract<TurnPhase, { readonly _tag: "Replied" }>): Transition<ReplyStep> => replied.held.some(isReply)
  ? moved({ _tag: "Hold", held: downgraded(replied.held) }, { ...replied, outcome: "failed", held: downgraded(replied.held) })
  : moved({ _tag: "Record", number: replied.number }, { ...replied, outcome: "failed" })

/**
 * The reply, with its outcome: recorded once, after the message is taken
 * (`Record`, the turn's number); nothing before. Once replied, a failed
 * reply downgrades a completed or partial one (a finish that failed after
 * it): the entries held for the closing commit are held again, the reply
 * failed under its own id (`Hold`), or, when memory never held it, the reply
 * is recorded again, failed. Anything else does nothing: a reply is never
 * upgraded.
 */
export const reply = (outcome: TurnOutcomeKind) => (phase: TurnPhase): Transition<ReplyStep> => Match.valueTags(phase, {
  Waiting: () => moved(nothing, phase),
  Taking: () => moved(nothing, phase),
  Taken: ({ number }) => moved<ReplyStep>({ _tag: "Record", number }, { _tag: "Replied", number, outcome, held: [] }),
  Replied: (replied) => outcome === "failed" && replied.outcome !== "failed" ? downgrade(replied) : moved(nothing, phase),
})

/**
 * Where entries memory records now go: once the turn replied, they are held
 * for its closing commit after everything held before them (returned: the
 * writer's `closing` takes them all, and `hold` keeps them once it did);
 * before it, a reply (TurnEnded) recorded on its own is held alone, and
 * anything else is stored as it is recorded (none).
 */
export const heldWith = (entries: ReadonlyArray<LogEntry>) => (phase: TurnPhase): Option.Option<ReadonlyArray<LogEntry>> => {
  const alone = () => Option.liftPredicate(entries, (all) => all.some(isReply))
  return Match.valueTags(phase, {
    Waiting: alone,
    Taking: alone,
    Taken: alone,
    Replied: ({ held }) => Option.some([...held, ...entries]),
  })
}

/** The entries the writer now holds for the closing commit (`heldWith`'s), kept by a replied turn. */
export const hold = (held: ReadonlyArray<LogEntry>) => (phase: TurnPhase): TurnPhase =>
  phase._tag === "Replied" ? { ...phase, held } : phase

/** The turn's number, once the message is taken. */
export const numberOf = (phase: TurnPhase): Option.Option<number> => Match.valueTags(phase, {
  Waiting: () => Option.none(),
  Taking: () => Option.none(),
  Taken: ({ number }) => Option.some(number),
  Replied: ({ number }) => Option.some(number),
})
