import { Effect, Option, Schema } from "effect"
import { InboxDroppedData, InboxQueuedData, STORED_FORMAT } from "@xandreed/core"
import type { InboxItem, InboxItemId, JsonObject, OpenTurn, QueuedInput, SessionHead, SessionView, TurnEndReason } from "@xandreed/core"
import { SessionsState } from "./sessions-state.entity.js"
import type { HeldTurn, HolderProcess, InboxSlot, ProcessLiveness, SessionsState as State } from "./sessions-state.entity.js"

const decodeState = Schema.decodeUnknownEffect(SessionsState)
const encodeState = Schema.encodeEffect(SessionsState)

/** A session's state before its first turn, in this release's stored format: a fork counts from its parent's turns. */
export const initialState = (head: SessionHead): State => ({
  v: 1,
  format: STORED_FORMAT,
  turns: Option.match(head.header.parent, { onNone: () => 0, onSome: (parent) => parent.turnAtFork }),
  open: Option.none(),
  title: Option.none(),
  inbox: [],
})

/** The plugin's state from a head (the initial state when there is none yet). */
export const stateOf = (head: SessionHead): Effect.Effect<State, Schema.SchemaError> =>
  head.state.sessions === undefined ? Effect.succeed(initialState(head)) : decodeState(head.state.sessions)

const decodeFormat = Schema.decodeUnknownEffect(Schema.Struct({ format: SessionsState.fields.format }))

/**
 * The stored format the head's state says the session was last written in,
 * read alone, before the rest of the state (a newer release may have
 * changed that): absent, as an earlier release wrote it or before any
 * commit, it is 1, the first.
 */
export const storedFormatOf = (head: SessionHead): Effect.Effect<number, Schema.SchemaError> =>
  head.state.sessions === undefined ? Effect.succeed(1) : decodeFormat(head.state.sessions).pipe(Effect.map((stored) => stored.format ?? 1))

/** Whether a session stored in `format` was written by a newer release than this one, which reads up to `STORED_FORMAT`. */
export const isNewerFormat = (format: number): boolean => format > STORED_FORMAT

/** The state in this release's stored format: raised when it says a lower one or none, the same value otherwise (so a commit that changes nothing else writes no state). */
export const withFormat = (state: State): State => (state.format ?? 0) < STORED_FORMAT ? { ...state, format: STORED_FORMAT } : state

/** The state as the head stores it. */
export const stateJson = (state: State): Effect.Effect<JsonObject, Schema.SchemaError> =>
  Effect.map(encodeState(state), (sessions) => ({ sessions }))

const encodeQueued = Schema.encodeEffect(InboxQueuedData)
const encodeDropped = Schema.encodeEffect(InboxDroppedData)

/** What `inbox.queued` stores of a delivered item. */
export const queuedData = (item: InboxItem): Effect.Effect<JsonObject, Schema.SchemaError> =>
  Effect.map(encodeQueued({ id: item.id, source: item.source, content: item.content }), (encoded) => ({ ...encoded }))

/** User input keeps its normalized message once, separate from a legacy notice's content. */
export const queuedInputData = (input: QueuedInput): Effect.Effect<JsonObject, Schema.SchemaError> =>
  Effect.map(encodeQueued({ id: input.id, source: input.source, content: "", input: { userMessage: input.userMessage, delivery: input.delivery } }), (encoded) => ({ ...encoded }))

/** What `inbox.dropped` stores of an item as many turns took and failed as the inbox allows. */
export const droppedData = (id: InboxItemId): Effect.Effect<JsonObject, Schema.SchemaError> =>
  Effect.map(encodeDropped({ id, reason: "attempts" }), (encoded) => ({ ...encoded }))

/**
 * Who asks whether a turn is held: this Sessions instance, the process it
 * runs in and how it tells whether another runs (whatever its own
 * ownership: a turn is judged by how it was taken), and the turn of a
 * session its writer let go of without storing the end.
 */
export interface Holder {
  readonly instance: string
  readonly liveness: ProcessLiveness
  /** This process, as a process-owned turn records it (none where the runtime has no process to name). */
  readonly process: Option.Option<HolderProcess>
  /** The turn of the session this instance let go of unended (its closing commit was not stored), if any. */
  readonly released: (session: string) => Effect.Effect<Option.Option<number>>
}

/**
 * Whether a turn another instance took under process ownership is still
 * held, by a process that runs. Another instance of this process holds it
 * while this process runs; a process that started later under the same pid
 * is gone; a process of this host is asked by its pid; one of another host,
 * or asked from where no process can be named, cannot be asked and holds. A
 * holder recorded without its process (an older version, or a runtime
 * without one) holds nothing.
 */
const processHolds = (open: HeldTurn, holder: Holder): Effect.Effect<boolean> => Option.match(open.process, {
  onNone: () => Effect.succeed(false),
  onSome: (running) => Option.match(holder.process, {
    onNone: () => Effect.succeed(true),
    onSome: (self) => running.host !== self.host ? Effect.succeed(true)
      : running.pid === self.pid ? Effect.succeed(running.startedAt === self.startedAt)
      : holder.liveness.alive(running.pid),
  }),
})

/**
 * Whether an open turn is still held, judged by what its record says and
 * never by the reader's own ownership, so a change of ownership (or
 * instances that differ in it) neither holds a turn forever nor reaps one
 * that runs: a turn with a lease end was taken under a lease, and is held
 * within it (storage time); one without was taken under process ownership,
 * and is held by its own instance, or by a process that runs. A turn this
 * instance let go of unended (`released`) is held by nobody.
 */
export const isHeld = (open: HeldTurn, now: number, holder: Holder, released: boolean): Effect.Effect<boolean> =>
  released ? Effect.succeed(false) : Option.match(open.expiresAt, {
    onSome: (end) => Effect.succeed(now <= end),
    onNone: () => open.holder === holder.instance ? Effect.succeed(true) : processHolds(open, holder),
  })

/** The turn a head has open and still held, if any. */
export const heldTurn = (head: SessionHead, state: State, holder: Holder): Effect.Effect<Option.Option<HeldTurn>> =>
  Option.match(state.open, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (open) => holder.released(head.header.id).pipe(
      Effect.flatMap((released) => isHeld(open, head.now, holder, open.holder === holder.instance && Option.contains(released, open.turn))),
      Effect.map((held) => held ? Option.some(open) : Option.none()),
    ),
  })

/** The open turn as hosts see it (where its holder runs is the plugin's). */
const openTurnOf = (held: HeldTurn): OpenTurn => ({
  turn: held.turn, runId: held.runId, key: held.key, origin: held.origin, holder: held.holder, expiresAt: held.expiresAt,
})

/** Inbox items waiting for a turn. */
export const pendingOf = (state: State): ReadonlyArray<InboxSlot> => state.inbox.filter((slot) => Option.isNone(slot.claimedBy))

/** Legacy notices acknowledge partial replies too; queued input needs completion or an explicit cancellation. */
const finished = (reason: TurnEndReason): boolean => reason === "completed" || reason === "partial" || reason === "cancelled"

/**
 * Close the open turn. Returns the state after it and the legacy notices it
 * dropped (taken by too many turns that did not finish them). Queued input
 * waits after failed, partial or interrupted turns without a drop limit. A turn that
 * did not try its items — interrupted before it wrote anything — returns
 * them to wait without counting an attempt.
 */
export const closedState = (state: State, reason: TurnEndReason, maxAttempts: number, tried: boolean): { readonly state: State; readonly dropped: ReadonlyArray<InboxItemId> } => {
  const turn = Option.map(state.open, (open) => open.turn)
  const taken = (slot: InboxSlot): boolean => Option.isSome(slot.claimedBy) && Option.contains(turn, slot.claimedBy.value)
  const counted = tried || reason !== "interrupted"
  const done = (slot: InboxSlot): boolean => slot.delivery === undefined ? finished(reason) : reason === "completed" || reason === "cancelled"
  const exhausted = (slot: InboxSlot): boolean => slot.delivery === undefined && counted && slot.attempts + 1 >= maxAttempts
  return {
    state: {
      ...state,
      open: Option.none(),
      inbox: state.inbox.flatMap((slot): ReadonlyArray<InboxSlot> => !taken(slot) ? [slot]
        : done(slot) || exhausted(slot) ? [] : [{ ...slot, attempts: counted ? slot.attempts + 1 : slot.attempts, claimedBy: Option.none() }]),
    },
    dropped: state.inbox.filter((slot) => taken(slot) && !done(slot) && exhausted(slot)).map((slot) => slot.id),
  }
}

/** One session as a host sees it: an open turn nobody holds any more (its lease ran out, its process stopped) is shown as closed. */
export const viewOf = (head: SessionHead, state: State, holder: Holder): Effect.Effect<SessionView> =>
  heldTurn(head, state, holder).pipe(Effect.map((open) => ({
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
