import { Effect, Option, Schema } from "effect"
import type { JsonObject, OpenTurn, SessionHead, SessionView, TurnEndReason } from "@xandreed/core"
import { SessionsState } from "./sessions-state.entity.js"
import type { HeldTurn, HolderProcess, InboxSlot, Ownership, ProcessLiveness, SessionsState as State } from "./sessions-state.entity.js"

const decodeState = Schema.decodeUnknownEffect(SessionsState)
const encodeState = Schema.encodeSync(SessionsState)

/** A session's state before its first turn: a fork counts from its parent's turns. */
export const initialState = (head: SessionHead): State => ({
  v: 1,
  turns: Option.match(head.header.parent, { onNone: () => 0, onSome: (parent) => parent.turnAtFork }),
  open: Option.none(),
  title: Option.none(),
  inbox: [],
})

/** The plugin's state from a head (the initial state when there is none yet). */
export const stateOf = (head: SessionHead): Effect.Effect<State, Schema.SchemaError> =>
  head.state.sessions === undefined ? Effect.succeed(initialState(head)) : decodeState(head.state.sessions)

/** The state as the head stores it. */
export const stateJson = (state: State): JsonObject => ({ sessions: encodeState(state) })

/** Who asks whether a turn is held: this Sessions instance, and how it tells whether a process runs. */
export interface Holder {
  readonly instance: string
  readonly liveness: ProcessLiveness
  /** This process, as its turns record it. */
  readonly process: Option.Option<HolderProcess>
}

/**
 * Whether a process-owned turn is still held: by this instance, or by a
 * process that runs. Another instance of this process holds it while this
 * process runs; a process that started later under the same pid is gone; a
 * process of this host is asked by its pid; one of another host cannot be
 * asked and holds. A holder recorded without its process (an older version)
 * holds nothing.
 */
const processHolds = (open: HeldTurn, holder: Holder): Effect.Effect<boolean> =>
  open.holder === holder.instance ? Effect.succeed(true) : Option.match(open.process, {
    onNone: () => Effect.succeed(false),
    onSome: (running) => Option.match(holder.process, {
      onNone: () => Effect.succeed(true),
      onSome: (self) => running.host !== self.host ? Effect.succeed(true)
        : running.pid === self.pid ? Effect.succeed(running.startedAt === self.startedAt)
        : holder.liveness.alive(running.pid),
    }),
  })

/** Whether an open turn is still held: within its lease (storage time), or by a process that runs. */
export const isHeld = (open: HeldTurn, now: number, ownership: Ownership, holder: Holder): Effect.Effect<boolean> =>
  ownership.mode === "process"
    ? processHolds(open, holder)
    : Effect.succeed(Option.match(open.expiresAt, { onNone: () => true, onSome: (end) => now <= end }))

/** The turn a head has open and still held, if any. */
export const heldTurn = (head: SessionHead, state: State, ownership: Ownership, holder: Holder): Effect.Effect<Option.Option<HeldTurn>> =>
  Option.match(state.open, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (open) => isHeld(open, head.now, ownership, holder).pipe(Effect.map((held) => held ? Option.some(open) : Option.none())),
  })

/** The open turn as hosts see it (where its holder runs is the plugin's). */
const openTurnOf = (held: HeldTurn): OpenTurn => ({
  turn: held.turn, runId: held.runId, key: held.key, origin: held.origin, holder: held.holder, expiresAt: held.expiresAt,
})

/** Inbox items waiting for a turn. */
export const pendingOf = (state: State): ReadonlyArray<InboxSlot> => state.inbox.filter((slot) => Option.isNone(slot.claimedBy))

/** A turn's end leaves the items it took done (completed, partial, cancelled) or waiting again, until too many attempts drop them. */
const finished = (reason: TurnEndReason): boolean => reason === "completed" || reason === "partial" || reason === "cancelled"

/**
 * Close the open turn. Returns the state after it and the inbox items it
 * dropped (taken by too many turns that did not finish them).
 */
export const closedState = (state: State, reason: TurnEndReason, maxAttempts: number): { readonly state: State; readonly dropped: ReadonlyArray<string> } => {
  const turn = Option.map(state.open, (open) => open.turn)
  const taken = (slot: InboxSlot): boolean => Option.isSome(slot.claimedBy) && Option.contains(turn, slot.claimedBy.value)
  const exhausted = (slot: InboxSlot): boolean => slot.attempts + 1 >= maxAttempts
  return {
    state: {
      ...state,
      open: Option.none(),
      inbox: state.inbox.flatMap((slot): ReadonlyArray<InboxSlot> => !taken(slot) ? [slot]
        : finished(reason) || exhausted(slot) ? [] : [{ ...slot, attempts: slot.attempts + 1, claimedBy: Option.none() }]),
    },
    dropped: finished(reason) ? [] : state.inbox.filter((slot) => taken(slot) && exhausted(slot)).map((slot) => slot.id),
  }
}

/** One session as a host sees it: an open turn nobody holds any more (its lease ran out, its process stopped) is shown as closed. */
export const viewOf = (head: SessionHead, state: State, ownership: Ownership, holder: Holder): Effect.Effect<SessionView> =>
  heldTurn(head, state, ownership, holder).pipe(Effect.map((open) => ({
    header: head.header,
    seq: head.seq,
    updatedAt: head.updatedAt,
    turns: state.turns,
    title: state.title,
    open: Option.map(open, openTurnOf),
    pending: pendingOf(state).length,
  })))

/** The title a session takes from its first user message: its first `chars` characters. */
export const titleOf = (text: string, chars: number): string => Array.from(text).slice(0, chars).join("")
