import { Cause, Clock, Context, Deferred, Effect, Equal, Exit, HashMap, Layer, Match, Option, PubSub, RcMap, Ref, Schema, Scope, Stream, Struct, SubscriptionRef } from "effect"
import {
  canonicalJson,
  ConversationId,
  EntryId,
  HarnessError,
  harnessDefectsAsFailures,
  InboxFull,
  InputConflict,
  isRevisionConflict,
  KeyConflict,
  normalizeUserMessage,
  NothingPending,
  NotResumable,
  reasonOf,
  RevisionConflict,
  readStored,
  readStoredKeys,
  RESERVED_KINDS,
  resumeRefusal,
  ReservedKind,
  RunId,
  RunIdReused,
  sameUserMessage,
  sessionAttributes,
  SessionBusy,
  SessionContended,
  SessionLog,
  SessionLogError,
  SessionMissing,
  Sessions,
  shutdownRefusal,
  STORED_FORMAT,
  SessionRef,
  sessionRef,
  sameSession,
  TurnActivity,
  TurnAdmission,
  TurnDuplicate,
  turnEndedDraft,
  turnEndedOf,
  turnEndingOf,
  turnStartedDraft,
  TurnStartedData,
  turnStartedOf,
  turnAttributes,
  TransactConflict,
  TransactDuplicate,
  TurnShutdown,
  UserMessage,
  WaitingInput,
} from "@xandreed/core"
import type {
  ActiveTurn,
  AdmittedTurn,
  AttachmentRejected,
  BeginTurn,
  Decided,
  Decision,
  InboxItem,
  InboxItemId,
  JsonObject,
  QueuedInput,
  ResumableTurn,
  SessionAddress,
  SessionCommitted,
  SessionDraft,
  SessionHead,
  SessionLogEvent,
  SessionView,
  Stored,
  TaskRef,
  TransactOptions,
  TransactRefusal,
  TurnDraft,
  TurnEnding,
  TurnFailure,
  TurnOrigin,
  TurnWriter,
  WaitingInputCount,
} from "@xandreed/core"
import { processLiveness } from "./process-liveness.adapter.js"
import { initialState, closedState, droppedData, heldTurn, isUnsupportedFormat, keyedData, pendingOf, queuedData, queuedInputData, stateJson, stateOf, storedFormatOf, titleOf, viewOf, waitingChanged } from "./sessions-state.entity.functions.js"
import type { Holder, ReleasedTurn } from "./sessions-state.entity.functions.js"
import { Ownership } from "./sessions-state.entity.js"
import type { HeldTurn, ProcessLiveness, SealedTurn, SessionsConfig, SessionsState } from "./sessions-state.entity.js"
import { makeTurnWriter } from "./turn-writer.adapter.js"
import type { OpenWriter } from "./turn-writer.adapter.js"
import type { ClosedBy } from "./turn-writer.entity.js"

/** One commit outside a turn: what to append and the state after it (nothing, to commit nothing). */
interface GuardedPlan<A> {
  readonly drafts: ReadonlyArray<SessionDraft>
  readonly next: Option.Option<SessionsState>
  readonly result: A
  /** A no-write decision used later journal evidence: verify its head before answering. */
  readonly validateRead?: boolean
}

interface Guarded<A> {
  readonly result: A
  readonly head: SessionHead
  readonly committed: Option.Option<SessionCommitted>
}

/**
 * Stored data that does not decode, as the store's failure (`session.state`,
 * `session.decode`). The plugin's own values (its state, the framework's
 * drafts) always encode, so a failure to encode one is a defect
 * (`Effect.orDie`), as is an answer the log's contract rules out.
 */
const storage = (code: string) => (error: Schema.SchemaError) => new SessionLogError({ code, message: error.message, cause: error })

/** The `inbox.dropped` drafts of turn `turn` for the items its close dropped. */
const droppedDrafts = (ids: ReadonlyArray<InboxItemId>, turn: number): Effect.Effect<ReadonlyArray<SessionDraft>> =>
  Effect.forEach(ids, (id) => droppedData(id).pipe(
    Effect.map((data): SessionDraft => ({ kind: "inbox.dropped", turn: Option.some(turn), data })),
    Effect.orDie,
  ), { concurrency: 1 })

/** The reply drafts a sealed turn's state keeps, stored in turn `turn` before its `turn.ended` by a close that is not its holder's. */
const sealedDrafts = (sealed: Option.Option<SealedTurn>, turn: number): ReadonlyArray<SessionDraft> =>
  Option.match(sealed, { onNone: () => [], onSome: (seal) => seal.closing.map((draft) => ({ kind: draft.kind, turn: Option.some(turn), data: draft.data })) })

const standalone = (drafts: ReadonlyArray<TurnDraft>): ReadonlyArray<SessionDraft> =>
  drafts.map((draft) => ({ kind: draft.kind, turn: Option.none(), data: draft.data }))

/**
 * What a begin asks for, by its kind: who begins the turn, its key, the
 * message it brings (none for the inbox, whose message is the items it
 * claims), the host's command, the turn it resumes and the task it runs.
 */
interface Asked {
  readonly origin: TurnOrigin
  readonly key: string
  readonly userMessage: Option.Option<UserMessage>
  readonly command: JsonObject
  readonly resumes: Option.Option<number>
  readonly task: Option.Option<TaskRef>
  readonly input: Option.Option<QueuedInput>
}

/** A begin as `Asked`: a user's and a task's turn are keyed by their caller, an inbox turn by its run id. */
const askedOf = (input: BeginTurn): Asked => Match.valueTags(input, {
  User: (user): Asked => ({
    origin: "user", key: user.key, userMessage: Option.some(user.userMessage), command: user.command,
    resumes: Option.fromNullishOr(user.resumes), task: Option.none(), input: Option.none(),
  }),
  Inbox: (inbox): Asked => ({ origin: "inbox", key: inbox.runId, userMessage: Option.none(), command: {}, resumes: Option.none(), task: Option.none(), input: Option.none() }),
  Queued: (queued): Asked => ({ origin: "user", key: `input:${queued.input}`, userMessage: Option.none(), command: {}, resumes: Option.none(), task: Option.none(), input: Option.none() }),
  Task: (task): Asked => ({
    origin: "task", key: task.key, userMessage: Option.some(task.userMessage), command: {}, resumes: Option.none(), task: Option.some(task.task), input: Option.none(),
  }),
})

/**
 * A pipeable of `Effect.fn` for a call that names a session: its id
 * (`sessionAttributes`) on the span the call opens and on the call's logs.
 */
const onSession = <A, E, R>(effect: Effect.Effect<A, E, R>, address: SessionAddress): Effect.Effect<A, E, R> => {
  const ids = sessionAttributes(address.id)
  return Effect.annotateCurrentSpan(ids).pipe(Effect.andThen(effect), Effect.annotateLogs(ids))
}

/**
 * What this instance has in flight: the turns it holds open, one entry per
 * session and turn (`<session>:<turn>`), and the begins still in progress.
 */
interface InFlight {
  readonly held: ReadonlyMap<string, ActiveTurn>
  readonly beginning: number
}

/** The sessions `WaitingInput` refreshes: those with queued input waiting, and the most recent quiet ones (oldest first). */
interface Known {
  readonly waiting: HashMap.HashMap<ConversationId, { readonly address: SessionAddress; readonly pending: number }>
  readonly quiet: ReadonlyArray<SessionAddress>
}

/**
 * Sessions over a SessionLog. The state (turns, the open turn, the title,
 * the inbox) is kept in the head and changed only by guarded commits, with
 * the events that justify it, so every instance over the same log agrees.
 * Turns are written by their `TurnWriter`; everything else here is one
 * compare-and-swap loop that plans again after a conflict. Under process
 * ownership, `liveness` names this process in the turns it holds and tells
 * whether another's still runs (by default, by host, pid and `kill(pid, 0)`).
 * It also provides `TurnActivity`: each begin from the moment it is asked
 * for until its writer is handed over (or it fails), then each turn until
 * its writer's scope closes. And it provides `TurnShutdown`: once it
 * refuses, every begin on this instance is refused (`shutdown`); once it
 * interrupts, every turn this instance holds is closed `turn.shutdown`. An
 * ownership the schema refuses (a keep-alive slower than half the lease)
 * fails the layer with `config.options`.
 */
/** What a resume's check reads of a `turn.started`: its origin and the turn it resumed, never the message and its images. */
const decodeResumeKeys = Schema.decodeUnknownEffect(TurnStartedData.mapFields(Struct.pick(["origin", "resumes"])))

export const SessionsLive = (config: SessionsConfig, options?: { readonly liveness?: ProcessLiveness }): Layer.Layer<Sessions | TurnActivity | TurnShutdown | WaitingInput, HarnessError, SessionLog | TurnAdmission> => Layer.effectContext(Effect.gen(function* () {
  yield* Schema.decodeUnknownEffect(Ownership)(config.ownership).pipe(
    Effect.mapError((error) => new HarnessError({ code: "config.options", plugin: "@xandreed/plugin-sessions", message: `ownership: ${error.message}` })))
  const log = yield* SessionLog
  const admission = yield* TurnAdmission
  const ownership = config.ownership
  const instance = yield* Effect.sync(() => crypto.randomUUID())
  const liveness = options?.liveness ?? processLiveness
  /** Per session, the turn this instance let go of without storing its end (or not knowing whether it opened): held by nobody from then on. */
  const released = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<ReleasedTurn>>>(new Map())
  const holder: Holder = {
    instance,
    liveness,
    // Named whatever this instance's ownership: a turn another took under process ownership is judged by its process.
    process: yield* liveness.current,
    released: (session) => Ref.get(released).pipe(Effect.map((all) => all.get(session) ?? [])),
  }
  /** Let go of a turn this instance opened whose end was not stored, so the next begin, deliver or drain here reaps it. */
  const isReleased = (gone: ReleasedTurn, open: { readonly turn: number; readonly runId: string }) => gone.turn === open.turn && gone.runId === open.runId
  /** The session's let-go turns kept by `keep`, the session forgotten when none is left. */
  const keepReleased = (id: string, keep: (gone: ReleasedTurn) => boolean) => Ref.update(released, (all) => {
    const kept = (all.get(id) ?? []).filter(keep)
    return kept.length === 0 ? new Map([...all].filter(([session]) => session !== id)) : new Map([...all, [id, kept]])
  })
  const letGo = (id: string, turn: number, runId: string) => Ref.update(released, (all) => {
    const before = (all.get(id) ?? []).filter((gone) => !isReleased(gone, { turn, runId }))
    return new Map([...all, [id, [...before, { turn, runId }]]])
  })
  /** Forget the turns let go of once a commit leaves the session without them open. */
  const forgetClosed = (id: string, next: SessionsState) => keepReleased(id, (gone) => Option.exists(next.open, (open) => isReleased(gone, open)))
  /** Forget a turn let go of that this instance has now opened, holding its writer: an earlier begin of it did not store its opening. */
  const forgetOpened = (id: string, turn: number, runId: string) => keepReleased(id, (gone) => !isReleased(gone, { turn, runId }))
  /**
   * Per followed session, one hub of change signals: sliding with room for
   * one, so a follower that does not pull holds one signal however many
   * commits it missed, and never loses the last. Held while someone follows
   * the session (`RcMap` releases it with the last follower), so a commit to
   * a session nobody follows signals nothing and keeps nothing.
   */
  const followers = yield* RcMap.make({ lookup: (_: ConversationId) => Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown) })
  const waitingHub = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown)
  /**
   * What `WaitingInput` refreshes: every owner-checked session last seen
   * with queued input waiting, and the `inbox.recentSessions` observed most
   * recently without any (oldest dropped first), so a foreign enqueue into a
   * session in use is seen without reading every session ever observed.
   */
  const known = yield* Ref.make<Known>({ waiting: HashMap.empty(), quiet: [] })
  const recent = (quiet: ReadonlyArray<SessionAddress>, address: SessionAddress): ReadonlyArray<SessionAddress> => {
    const kept = [...quiet.filter((seen) => seen.id !== address.id), address]
    return kept.slice(Math.max(0, kept.length - config.inbox.recentSessions))
  }
  const observe = (address: SessionAddress) => Ref.update(known, (now): Known => Option.exists(HashMap.get(now.waiting, address.id), (seen) => seen.address.owner === address.owner)
    ? now : { ...now, quiet: recent(now.quiet, address) })
  const remember = (address: SessionAddress, state: SessionsState) => Ref.update(known, (now): Known => {
    const pending = pendingOf(state).filter((slot) => slot.delivery !== undefined).length
    return pending > 0
      ? { waiting: HashMap.set(now.waiting, address.id, { address, pending }), quiet: now.quiet.filter((seen) => seen.id !== address.id) }
      : { waiting: HashMap.remove(now.waiting, address.id), quiet: recent(now.quiet, address) }
  })
  const forget = (address: SessionAddress) => Ref.update(known, (now): Known => ({
    waiting: Option.exists(HashMap.get(now.waiting, address.id), (seen) => seen.address.owner === address.owner) ? HashMap.remove(now.waiting, address.id) : now.waiting,
    quiet: now.quiet.filter((seen) => seen.id !== address.id || seen.owner !== address.owner),
  }))
  /** The writer this instance holds per session, for a local cancel or removal. */
  const writerKey = (reference: SessionRef) => canonicalJson([reference.id, reference.owner, reference.incarnation])
  const writers = yield* Ref.make(new Map<string, OpenWriter & { readonly turn: number; readonly reference: SessionRef }>())
  const inFlight = yield* SubscriptionRef.make<InFlight>({ held: new Map(), beginning: 0 })
  /** Where this instance is in a shutdown: running, refusing every begin, or also closing every turn it holds. */
  const stopping = yield* Ref.make<"running" | "refusing" | "interrupting">("running")
  const refuseIfStopping = (address: SessionAddress) => Ref.get(stopping).pipe(Effect.flatMap((now) => now === "running" ? Effect.void : Effect.fail(shutdownRefusal(address.id))))
  const heldKey = (id: string, turn: number) => `${id}:${turn}`
  const beginSettled = SubscriptionRef.update(inFlight, (now): InFlight => ({ ...now, beginning: now.beginning - 1 }))
  /**
   * Signal the session's followers after any commit, and every local inbox
   * drainer and waiting-input probe (`waiting`) only after one that changed
   * the open turn or the inbox (`waitingChanged`), or created or removed a
   * session: a turn's own appends wake no rescan.
   */
  const wake = (id: ConversationId, waiting: boolean) => RcMap.getOption(followers, id).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (hub) => PubSub.publish(hub, undefined).pipe(Effect.asVoid) })),
    Effect.scoped,
    Effect.andThen(waiting ? PubSub.publish(waitingHub, undefined) : Effect.void),
    Effect.asVoid,
  )
  const freshId = Effect.sync(() => ConversationId.make(crypto.randomUUID()))

  const stateFrom = (head: SessionHead) => stateOf(head).pipe(
    Effect.mapError(storage("session.state")),
    Effect.tap((state) => remember({ id: head.header.id, owner: head.header.owner }, state)),
  )
  /**
   * A session a newer release wrote (its stored format above this
   * release's) is refused for writes and turns before anything is planned:
   * this release cannot tell what that release's records mean, and must not
   * write its own beside them. Reads are not refused.
   */
  const refuseUnsupported = (head: SessionHead) => storedFormatOf(head).pipe(
    Effect.mapError(storage("session.state")),
    Effect.flatMap((format) => isUnsupportedFormat(format)
      ? Effect.fail(new SessionLogError({ code: "session.version", message: `the session uses unsupported stored format ${format}; configure a fresh store for format ${STORED_FORMAT}` }))
      : Effect.void),
  )
  const owned = (address: SessionAddress): Effect.Effect<SessionHead, SessionMissing | SessionLogError> => Effect.gen(function* () {
    const head = yield* log.head(address.id)
    const reference = Schema.decodeUnknownOption(SessionRef)(address)
    if (head.header.owner !== address.owner || Option.exists(reference, (value) => !sameSession(value, head))) return yield* Effect.fail(new SessionMissing({ session: address.id }))
    yield* refuseUnsupported(head)
    yield* observe(address)
    return head
  })
  const viewFrom = (head: SessionHead) => stateFrom(head).pipe(Effect.flatMap((state) => viewOf(head, state, holder)))

  /**
   * Plan from the head and commit it, against the revision planned from;
   * after a conflict, plan again at once, `config.retries` attempts in all
   * before `SessionContended`. The commit is not interrupted half way, and
   * `stored` runs with it: an interruption waits for the store's answer and
   * for what must follow a stored commit. A session a newer release wrote
   * is refused before the plan (`session.version`); the plan starts from
   * the state in this release's stored format, and a commit stores the
   * state so even when the plan leaves it as it was (once, for a session
   * an earlier release wrote).
   */
  const guarded = <A, E>(locator: SessionAddress, plan: (head: SessionHead, state: SessionsState) => Effect.Effect<GuardedPlan<A>, E>, stored: (result: A) => Effect.Effect<void> = () => Effect.void): Effect.Effect<Guarded<A>, E | SessionMissing | SessionContended | SessionLogError> => owned(locator).pipe(Effect.flatMap((initial) => {
    const address = sessionRef(initial)
    const once = (head: SessionHead): Effect.Effect<Guarded<A>, E | SessionMissing | RevisionConflict | SessionLogError> => Effect.gen(function* () {
      yield* refuseUnsupported(head)
      const held = yield* stateFrom(head)
      const current = held
      const planned = yield* plan(head, current)
      if (planned.drafts.length === 0 && Option.isNone(planned.next)) {
        if (planned.validateRead === true) {
          const actual = yield* owned(address)
          if (actual.revision !== head.revision) return yield* Effect.fail(new RevisionConflict({ session: address.id, expected: head.revision, actual: actual.revision }))
        }
        return { result: planned.result, head, committed: Option.none() }
      }
      const next = planned.next
      const state = yield* Option.match(next, {
        onNone: () => Effect.succeedNone,
        onSome: (written) => stateJson(written).pipe(Effect.map(Option.some), Effect.orDie),
      })
      return yield* Effect.uninterruptible(Effect.gen(function* () {
        const outcome = yield* Effect.result(log.commit(sessionRef(head), {
          expect: head.revision, notAfter: Option.none(), events: planned.drafts, state,
        }))
        if (outcome._tag === "Success") {
          yield* stored(planned.result)
          yield* Option.match(planned.next, { onNone: () => Effect.void, onSome: (after) => forgetClosed(address.id, after) })
          const after = Option.getOrElse(next, () => current)
          yield* remember(address, after)
          yield* wake(address.id, waitingChanged(held, after))
          return { result: planned.result, head, committed: Option.some(outcome.success) }
        }
        const error = outcome.failure
        // A conflict fails this attempt as it is, for the retry below. The commit has no `notAfter`: a log that says it expired broke its contract.
        return yield* (error._tag === "LeaseExpired" ? Effect.die(error) : Effect.fail(error))
      }))
    })
    const retry = (head: SessionHead, remaining: number): Effect.Effect<Guarded<A>, E | SessionMissing | SessionContended | SessionLogError> => once(head).pipe(
      Effect.catchIf(isRevisionConflict, () => remaining <= 1
        ? Effect.fail(new SessionContended({ session: address.id, attempts: config.retries }))
        : owned(address).pipe(Effect.flatMap((next) => retry(next, remaining - 1)))),
    )
    return retry(initial, config.retries)
  }))

  /**
   * An open turn nobody holds any more (its lease ran out, or its process is
   * gone) is closed as interrupted: the drafts that close it, the state
   * after them, and the turn they close. With `takeOver`, the host's word
   * that its holder is gone, the open turn is closed so whoever holds it,
   * with code `turn.takeover`, and no attempt is counted: the items it took
   * were not the reason it stopped.
   */
  const reaped = (head: SessionHead, state: SessionsState, takeOver: NonNullable<BeginTurn["takeOver"]> = false) => Effect.gen(function* () {
    const applies = Option.exists(state.open, (open) => typeof takeOver === "boolean" ? takeOver : open.turn === takeOver.turn && open.runId === takeOver.runId)
    if (Option.isNone(state.open) || (!applies && Option.isSome(yield* heldTurn(head, state, holder)))) return { drafts: [] as ReadonlyArray<SessionDraft>, state, closed: Option.none<number>(), closedAs: Option.none<TurnEnding["reason"]>() }
    const turn = state.open.value.turn
    const taken = applies && Option.isSome(yield* heldTurn(head, state, holder))
    // A sealed turn's reply was final before its holder went: it ends as sealed, its reply stored, never interrupted.
    const sealed = state.open.value.sealed
    const ending = Option.match(sealed, {
      onSome: (seal) => seal.ending,
      onNone: (): TurnEnding => ({
        reason: "interrupted",
        failure: Option.some(taken
          ? { code: "turn.takeover", message: "a new holder took the session over" }
          : { code: "turn.lease", message: "the turn's holder stopped writing" }),
      }),
    })
    // A reaped turn counts as an attempt: its holder may have stopped on the items. One taken over does not.
    const after = closedState(state, ending.reason, config.inbox.attempts, !taken)
    const closing = yield* turnEndedDraft(turn, ending).pipe(Effect.orDie)
    const dropped = yield* droppedDrafts(after.dropped, turn)
    return { drafts: [...sealedDrafts(sealed, turn), closing, ...dropped], state: after.state, closed: Option.some(turn), closedAs: Option.some(ending.reason) }
  })

  /**
   * Close the open turn as `reaped` would, in a commit of its own, when its
   * final reply sealed it: a refused begin does this after its plan, so a
   * sealed turn its holder left is stored as it sealed (its reply with it)
   * whatever the begin decided. Its refusal (the turn it resumes is that
   * sealed one, finished; its queued input that turn already answered)
   * drops the plan's reap with it, and would leave the turn open for the
   * next begin to refuse again. Any other open turn is left to the next
   * opening plan.
   */
  const reapSealed = (address: SessionAddress, takeOver: NonNullable<BeginTurn["takeOver"]>) => guarded(address, (head, stored) => Effect.gen(function* () {
    if (!Option.exists(stored.open, (open) => Option.isSome(open.sealed))) return { drafts: [], next: Option.none<SessionsState>(), result: Option.none<number>() }
    const reap = yield* reaped(head, stored, takeOver)
    return Option.isSome(reap.closed) ? { drafts: reap.drafts, next: Option.some(reap.state), result: reap.closed } : { drafts: [], next: Option.none<SessionsState>(), result: Option.none<number>() }
  })).pipe(
    // Taken over here, as an opening commit's reap would: this instance's writer of it, if any, is closed at once.
    Effect.flatMap((done) => Option.match(done.result, { onNone: () => Effect.void, onSome: (taken) => closeLocal(sessionRef(done.head), "interrupted", Option.some(taken)) })),
  )

  /**
   * A session's own `turn.started` events, for lookups that decode their keys
   * alone: a media-storing log leaves the messages' images as references.
   */
  const startsOf = (id: SessionRef, through?: number) => log.read(id, { after: 0, ...(through === undefined ? {} : { through }), limit: Option.none(), kinds: ["turn.started"], media: "references" })

  /** One `turn.started` a lookup found, read again whole, its images included. */
  const startedWhole = (id: SessionRef, found: SessionLogEvent) => log.read(id, { after: found.seq - 1, through: found.seq, limit: Option.some(1), kinds: ["turn.started"] }).pipe(
    Effect.flatMap((events) => Option.match(Option.fromNullishOr(events.find((event) => event.seq === found.seq)), {
      onNone: () => Effect.fail(new SessionLogError({ code: "session.decode", message: "a turn.started a lookup found is no longer stored" })),
      onSome: (event) => turnStartedOf(event).pipe(Effect.mapError(storage("session.decode"))),
    })),
  )

  /** Of these `turn.started` events (their keys decoded, never the message), the turn begun with `key`, and what it was begun with. */
  const keyIn = (starts: ReadonlyArray<SessionLogEvent>, key: string) => readStoredKeys("turn.started", starts).pipe(
    Effect.map((keyed) => Option.map(Option.fromNullishOr(keyed.find((started) => started.keys.key === key)), ({ event }) => ({ turn: Option.getOrElse(event.turn, () => 0), event }))),
    Effect.mapError(storage("session.decode")),
  )

  /** The turn begun with `key`, and what it was begun with. */
  const keyed = (id: SessionRef, key: string) => startsOf(id).pipe(Effect.flatMap((starts) => keyIn(starts, key)))

  /**
   * The turn begun under `runId`: of the session's own `turn.started` events
   * (`starts`), or of the history a fork inherits (each parent up to its fork
   * point). Memory numbers a turn's entries from its run id over that whole
   * history.
   */
  const runOf = (header: SessionHead["header"], starts: ReadonlyArray<SessionLogEvent>, runId: string) => {
    const begunIn = (events: ReadonlyArray<SessionLogEvent>, through: number) => readStoredKeys("turn.started", events).pipe(
      Effect.map((keyed) => Option.map(Option.fromNullishOr(keyed.find((started) => started.keys.runId === runId && started.event.seq <= through)),
        ({ event }) => Option.getOrElse(event.turn, () => 0))),
      Effect.mapError(storage("session.decode")),
    )
    const inherited = (lineage: SessionHead["header"]["parent"]): Effect.Effect<Option.Option<number>, SessionMissing | SessionLogError> => Option.match(lineage, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (parent) => parent.through <= 0 ? Effect.succeed(Option.none()) : startsOf(parent, parent.through).pipe(
        Effect.flatMap((events) => begunIn(events, parent.through)),
        Effect.flatMap(Option.match({
          onSome: (turn) => Effect.succeed(Option.some(turn)),
          onNone: () => owned(parent).pipe(Effect.flatMap((head) => inherited(head.header.parent))),
        }))),
    })
    return begunIn(starts, Number.POSITIVE_INFINITY).pipe(Effect.flatMap(Option.match({ onSome: (turn) => Effect.succeed(Option.some(turn)), onNone: () => inherited(header.parent) })))
  }

  /**
   * The session's own turns, each as begun (with the turn it resumed) and as
   * ended (when it was), for a resume's check; `reapedNow`, a turn this
   * commit closes as interrupted, counts as ended so.
   */
  const turnsOf = (id: SessionRef, reapedNow: Option.Option<{ readonly turn: number; readonly reason: TurnEnding["reason"] }>) => log.read(id, { after: 0, limit: Option.none(), kinds: ["turn.started", "turn.ended"], media: "references" }).pipe(
    Effect.flatMap((events) => Effect.gen(function* () {
      const numbered = (event: SessionLogEvent) => Option.getOrElse(event.turn, () => 0)
      const endings = new Map(yield* Effect.forEach(events.filter((event) => event.kind === "turn.ended"), (event) =>
        turnEndedOf(event).pipe(Effect.map((ended) => [numbered(event), ended.reason] as const)), { concurrency: 1 }))
      return yield* Effect.forEach(events.filter((event) => event.kind === "turn.started"), (event) => decodeResumeKeys(event.data).pipe(Effect.map((started): ResumableTurn => ({
        turn: numbered(event),
        origin: started.origin,
        resumes: Option.fromNullishOr(started.resumes),
        // A turn reaped in this very commit ends as its reap stores it: interrupted, or as its final reply sealed it.
        ended: Option.match(Option.filter(reapedNow, (reaped) => reaped.turn === numbered(event)), {
          onSome: (reaped) => Option.some(reaped.reason),
          onNone: () => Option.fromNullishOr(endings.get(numbered(event))),
        }),
      }))), { concurrency: 1 })
    }).pipe(Effect.mapError(storage("session.decode")))),
  )

  /** The session's keyed transact under `key`, its record decoded, if it recorded one. */
  const keyedTransact = (id: SessionRef, key: string) => log.read(id, { after: 0, limit: Option.none(), kinds: ["transact.keyed"] }).pipe(
    Effect.flatMap((events) => readStored("transact.keyed", events).pipe(Effect.mapError(storage("session.decode")))),
    Effect.map((keyed) => Option.fromNullishOr(keyed.find((found) => found.data.key === key))),
  )

  /** A repeat of a keyed transact: the first one's events (directly after its record, in its commit), or a conflict when its command differs. */
  const repeated = (address: SessionRef, options: TransactOptions, found: Stored<"transact.keyed">) =>
    canonicalJson(found.data.command) !== canonicalJson(options.command ?? {})
      ? Effect.fail(new TransactConflict({ session: address.id, key: options.key }))
      : (found.data.events === 0 ? Effect.succeed([]) : log.read(address, { after: found.event.seq, through: found.event.seq + found.data.events, limit: Option.none(), kinds: [] })).pipe(
        Effect.flatMap((events) => Effect.fail(new TransactDuplicate({ session: address.id, key: options.key, events }))),
      )

  // A keyed transact's record opens its commit: a repeat finds it (a racing one, after its commit conflicts) and decides nothing.
  const runTransact = Effect.fn("sessions.transact")(<A, E>(address: SessionAddress, decide: (view: SessionView) => Effect.Effect<Decision<A>, E>, options?: TransactOptions) => guarded(address, (head, state) => Effect.gen(function* () {
    if (options !== undefined) {
      const earlier = yield* keyedTransact(sessionRef(head), options.key)
      if (Option.isSome(earlier)) return yield* repeated(sessionRef(head), options, earlier.value)
    }
    const decision = yield* decide(yield* viewOf(head, state, holder))
    const reserved = decision.drafts.find((draft) => RESERVED_KINDS.includes(draft.kind))
    if (reserved !== undefined) return yield* Effect.fail(new ReservedKind({ kind: reserved.kind }))
    const keyed = options === undefined ? [] : [{
      kind: "transact.keyed", turn: Option.none(), data: yield* keyedData(options.key, options.command ?? {}, decision.drafts.length).pipe(Effect.orDie),
    } satisfies SessionDraft]
    return { drafts: [...keyed, ...standalone(decision.drafts)], next: Option.none<SessionsState>(), result: decision.result }
  })).pipe(Effect.map((done): Decided<A> => ({
    result: done.result,
    events: Option.match(done.committed, { onNone: () => [], onSome: (committed) => committed.events.filter((event) => event.kind !== "transact.keyed") }),
  }))), onSession)
  /** `Sessions.transact`: a keyed one's refusals only in the type of a call given a key (`TransactRefusal`). */
  function transact<A, E, O extends TransactOptions | undefined = undefined>(address: SessionAddress, decide: (view: SessionView) => Effect.Effect<Decision<A>, E>, options?: O):
    Effect.Effect<Decided<A>, E | ReservedKind | TransactRefusal<O> | SessionMissing | SessionContended | SessionLogError>
  function transact<A, E>(address: SessionAddress, decide: (view: SessionView) => Effect.Effect<Decision<A>, E>, options?: TransactOptions) {
    return runTransact(address, decide, options)
  }

  /** The session's `inbox.queued` records, decoded. */
  const queuedIn = (id: SessionRef) => log.read(id, { after: 0, limit: Option.none(), kinds: ["inbox.queued"] }).pipe(
    Effect.flatMap((events) => readStored("inbox.queued", events).pipe(Effect.mapError(storage("session.decode")))),
  )

  /** A consumed steer is acknowledged by its receipt's outer turn, not a fabricated queued begin. */
  const takenInputOf = (id: SessionRef, wanted: InboxItemId, through: number) => log.read(id, { after: 0, through, limit: Option.none(), kinds: ["inbox.taken"] }).pipe(
    Effect.flatMap((events) => readStored("inbox.taken", events.filter((event) => event.seq <= through)).pipe(Effect.mapError(storage("session.decode")))),
    Effect.flatMap((taken) => {
      const receipt = taken.find(({ data }) => data.id === wanted)
      if (receipt === undefined) return Effect.succeedNone
      return Option.match(Option.filter(receipt.event.turn, (turn) => Number.isSafeInteger(turn) && turn >= 1), {
        onNone: () => Effect.fail(new SessionLogError({ code: "session.decode", message: "a consumed input receipt has no consuming turn" })),
        onSome: (turn) => Effect.succeedSome(turn),
      })
    }),
  )

  /** Immutable user input, decoded separately from legacy notice deliveries. */
  const queuedInputOf = (id: SessionRef, wanted: InboxItemId) => queuedIn(id).pipe(Effect.map((queued) =>
    Option.fromNullishOr(queued.flatMap(({ data }): ReadonlyArray<QueuedInput> => data.id === wanted && data.input !== undefined
      ? [{ id: data.id, source: data.source, ...data.input }] : []).at(0))))

  /** Input provenance without decoding the earlier messages and their images. */
  const inputStartsOf = (starts: ReadonlyArray<SessionLogEvent>) => readStoredKeys("turn.started", starts).pipe(Effect.mapError(storage("session.decode")))
  const attemptKey = (id: InboxItemId, last: Option.Option<number>, runId: RunId): string => Option.match(last, {
    onNone: () => `input:${id}`,
    onSome: (turn) => `input-retry:${canonicalJson([id, turn, runId])}`,
  })
  const lastInputTurn = (starts: Effect.Success<ReturnType<typeof inputStartsOf>>, id: InboxItemId): Option.Option<number> =>
    Option.fromNullishOr(starts.filter((started) => started.keys.input === id).map(({ event }) => Option.getOrElse(event.turn, () => 0)).at(-1))

  /** Resolve the real input and attempt key before the host's admission sees them. */
  const prepareAsked = (address: SessionRef, input: BeginTurn, asked: Asked) => Effect.gen(function* () {
    if (input._tag === "Queued") {
      yield* owned(address)
      const queued = yield* queuedInputOf(address, input.input)
      if (Option.isNone(queued)) return yield* Effect.fail(new NothingPending({ session: address.id }))
      const starts = yield* inputStartsOf(yield* startsOf(address))
      const retry = starts.find((started) => started.keys.input === input.input && started.keys.runId === input.runId)
      return { ...asked, input: queued, userMessage: Option.some(queued.value.userMessage), key: retry?.keys.key ?? attemptKey(input.input, lastInputTurn(starts, input.input), input.runId) }
    }
    if (Option.isNone(asked.resumes)) return asked
    const resumed = asked.resumes.value
    yield* owned(address)
    const starts = yield* inputStartsOf(yield* startsOf(address))
    const target = starts.find(({ event }) => Option.contains(event.turn, resumed))
    if (target?.keys.input === undefined) return asked
    return { ...asked, input: yield* queuedInputOf(address, target.keys.input) }
  })

  /** The inbox items with these ids, as delivered. */
  const inboxItems = (id: SessionRef, ids: ReadonlyArray<InboxItemId>) => queuedIn(id).pipe(
    Effect.map((queued) => ids.flatMap((wanted): ReadonlyArray<InboxItem> => Option.toArray(Option.fromNullishOr(queued.find((item) => item.data.id === wanted && item.data.input === undefined))).map(({ data }) => ({
      id: wanted,
      source: data.source,
      content: data.content.length > 0 ? data.content : `(inbox item ${wanted})`,
    })))),
  )

  /**
   * Close a turn this instance opened whose begin never handed it to a
   * writer (interrupted after its commit). When that commit is not stored
   * either, it is logged and the turn let go of.
   */
  const unhanded = (address: SessionAddress, admitted: AdmittedTurn, exit: Exit.Exit<unknown, unknown>) => guarded(address, (_head, state) => Effect.gen(function* () {
    const turn = admitted.turn
    if (!Option.exists(state.open, (open) => open.turn === turn && open.holder === instance)) return { drafts: [], next: Option.none<SessionsState>(), result: undefined }
    const interrupted = Exit.hasInterrupts(exit)
    const reason = interrupted ? "interrupted" as const : "failed" as const
    const after = closedState(state, reason, config.inbox.attempts, false)
    const closing = yield* turnEndedDraft(turn, {
      reason,
      failure: Option.some(interrupted
        ? { code: "turn.interrupted", message: "the turn's begin was interrupted before its writer was handed over" }
        : { code: "turn.unended", message: "the turn's scope closed before it ended" }),
    }).pipe(Effect.orDie)
    const dropped = yield* droppedDrafts(after.dropped, turn)
    return { drafts: [closing, ...dropped], next: Option.some(after.state), result: undefined }
  })).pipe(
    Effect.timeout("10 seconds"),
    Effect.tapError(() => letGo(address.id, admitted.turn, admitted.runId)),
    Effect.ignore({ log: "Warn", message: "a turn whose begin was cut was not closed; this instance lets it go, for the next begin to reap" }),
    Effect.annotateLogs(turnAttributes(admitted)),
  )

  /**
   * Open a turn. Everything after the opening commit runs uninterruptibly
   * until the writer (and its finalizer) exists; what may wait — the host's
   * admission, the reads — stays interruptible, and a turn committed under
   * an admission that is then interrupted is closed by the scope. The begin
   * counts in `inFlight` from before the admission until the writer is held,
   * in the same update that counts the turn as open; a begin that fails
   * stops counting then, unless it committed a turn, which counts until the
   * scope has closed that turn.
   */
  const openTurn = (locator: SessionAddress, input: BeginTurn) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const address = sessionRef(yield* owned(locator))
    const scope = yield* Effect.scope
    const at = yield* Clock.currentTimeMillis
    const meta = input.meta ?? {}
    const initial = askedOf(input)
    // `resumes` is typed only as a number: one that is not a whole number of at least 1 names no turn, refused before the host's admission sees it.
    const unnumbered = Option.filter(initial.resumes, (turn) => !(Number.isSafeInteger(turn) && turn >= 1))
    if (Option.isSome(unnumbered)) return yield* Effect.fail(new NotResumable({ session: address.id, turn: unnumbered.value, reason: "missing" }))
    /** The turn the opening commit stored, until its writer is handed over. */
    const unowned = yield* Ref.make(Option.none<AdmittedTurn>())
    /** The turn the last opening plan would open: let go of when its commit fails, as the store may have stored it all the same. */
    const planned = yield* Ref.make(Option.none<number>())
    yield* SubscriptionRef.update(inFlight, (now): InFlight => ({ ...now, beginning: now.beginning + 1 }))
    yield* Scope.addFinalizerExit(scope, (exit) => Ref.get(unowned).pipe(Effect.flatMap(Option.match({
      onNone: () => Effect.void,
      onSome: (admitted) => unhanded(address, admitted, exit).pipe(Effect.ensuring(beginSettled)),
    }))))
    return yield* Effect.gen(function* () {
      // Refused before the host's admission is asked, and again in the plan: a begin past this check while a shutdown starts opens nothing.
      yield* refuseIfStopping(address)
      const asked = yield* restore(prepareAsked(address, input, initial))
      const { key, origin, resumes } = asked
      const resuming = Option.match(resumes, { onNone: () => ({}), onSome: (turn) => ({ resumes: turn }) })
      const tasked = Option.match(asked.task, { onNone: () => ({}), onSome: (task) => ({ task }) })
      const linked = Option.match(asked.input, { onNone: () => ({}), onSome: (queued) => ({ input: queued.id }) })
      const inputData = Option.match(asked.input, { onNone: () => ({}), onSome: (queued) => ({ input: queued }) })
      const toAdmit = { session: address, origin, runId: input.runId, key, meta, ...resuming, ...tasked, ...linked }
      // Only the opening commit is admitted: the writer's later commits run outside the host's admission.
      const begun = yield* restore(admission.admit(toAdmit, guarded(address, (head, stored) => Effect.gen(function* () {
        yield* Ref.set(planned, Option.none())
        yield* refuseIfStopping(address)
        const reap = yield* reaped(head, stored, input.takeOver ?? false)
        const state = reap.state
        const starts = yield* startsOf(address)
        if (input._tag === "Queued") {
          const taken = yield* takenInputOf(sessionRef(head), input.input, head.seq)
          if (Option.isSome(taken)) return yield* Effect.fail(new TurnDuplicate({
            session: address.id, turn: taken.value, open: Option.exists(state.open, (open) => open.turn === taken.value),
          }))
        }
        // A turn that brings its message (a user's, a task's) is keyed by its caller: the key's earlier turn is this one or a conflict.
        if (Option.isSome(asked.userMessage)) {
          const brought = asked.userMessage.value
          const previous = yield* keyIn(starts, key)
          if (Option.isSome(previous)) {
            const started = yield* startedWhole(sessionRef(head), previous.value.event)
            // The key's fingerprint is the message, the command, the turn resumed and the task, never `meta`: a retry with other metadata is the same turn.
            const same = sameUserMessage(started.userMessage, brought) && canonicalJson(started.command) === canonicalJson(asked.command)
              && Equal.equals(Option.fromNullishOr(started.resumes), resumes)
              && canonicalJson(started.task ?? null) === canonicalJson(Option.getOrNull(asked.task))
              && (started.input ?? null) === Option.match(asked.input, { onNone: () => null, onSome: (queued) => queued.id })
            return yield* Effect.fail(same
              ? new TurnDuplicate({ session: address.id, turn: previous.value.turn, open: Option.exists(state.open, (open) => open.turn === previous.value.turn) })
              : new KeyConflict({ session: address.id, key, turn: previous.value.turn }))
          }
        }
        // A run id names one turn's run: a begin reusing one (a retry under a new key, say) is refused before it opens anything.
        const reused = yield* runOf(head.header, starts, input.runId)
        if (Option.isSome(reused)) return yield* Effect.fail(new RunIdReused({ session: address.id, runId: input.runId, turn: reused.value }))
        if (Option.isSome(state.open)) return yield* Effect.fail(new SessionBusy({ session: address.id, turn: state.open.value.turn }))
        if (input._tag === "Queued") {
          const last = lastInputTurn(yield* inputStartsOf(starts), input.input)
          const waiting = pendingOf(state).some((slot) => slot.id === input.input && slot.delivery !== undefined)
          if (!waiting || key !== attemptKey(input.input, last, input.runId)) return yield* Option.match(last, {
            onNone: () => Effect.fail(new NothingPending({ session: address.id })),
            onSome: (turn) => Effect.fail(new TurnDuplicate({ session: address.id, turn, open: false })),
          })
        }
        // A resume is checked in the commit that opens it, against the turns as stored (a turn reaped by this commit is interrupted).
        if (Option.isSome(resumes)) {
          const refusal = resumeRefusal(resumes.value, yield* turnsOf(sessionRef(head), Option.all({ turn: reap.closed, reason: reap.closedAs })))
          if (Option.isSome(refusal)) return yield* Effect.fail(new NotResumable({ session: address.id, turn: resumes.value, reason: refusal.value }))
        }
        // An inbox turn takes every item waiting, and its message is theirs.
        const waiting = origin === "inbox" ? pendingOf(state).filter((slot) => slot.delivery === undefined).map((slot) => slot.id) : []
        if (origin === "inbox" && waiting.length === 0) return yield* Effect.fail(new NothingPending({ session: address.id }))
        const claimed = yield* inboxItems(sessionRef(head), waiting)
        const inputWaiting = Option.toArray(asked.input).flatMap((queued) => pendingOf(state).some((slot) => slot.id === queued.id && slot.delivery !== undefined) ? [queued.id] : [])
        const taking = [...waiting, ...inputWaiting]
        const userMessage = Option.getOrElse(asked.userMessage, () => new UserMessage({ text: claimed.map((item) => item.content).join("\n\n") }))
        const turn = state.turns + 1
        const open: HeldTurn = {
          turn, runId: input.runId, key, origin, holder: instance,
          expiresAt: ownership.mode === "lease" ? Option.some(head.now + ownership.ttlMs) : Option.none(),
          process: ownership.mode === "process" ? holder.process : Option.none(),
          sealed: Option.none(),
        }
        const next: SessionsState = {
          ...state,
          turns: turn,
          open: Option.some(open),
          // A session is titled by the first message a user or a task brought.
          title: Option.orElse(state.title, () => Option.map(Option.filter(asked.userMessage, (brought) => brought.text.length > 0), (brought) => titleOf(brought.text, config.titleChars))),
          inbox: state.inbox.map((slot) => taking.includes(slot.id) ? { ...slot, claimedBy: Option.some(turn) } : slot),
        }
        const starting = yield* turnStartedDraft(turn, {
          runId: input.runId, key, origin, userMessage, command: asked.command,
          claimed: waiting, entry: EntryId.make(`${input.runId}:0`), at,
          // Written only when given: a turn begun without metadata is stored as before.
          ...(input.meta === undefined ? {} : { meta: input.meta }),
          ...resuming,
          ...tasked,
          ...linked,
        }).pipe(Effect.orDie)
        const admitted: AdmittedTurn = {
          session: address, turn, runId: input.runId, key, origin, userMessage,
          command: asked.command, claimed, meta, ...resuming, ...tasked, ...inputData,
        }
        yield* Ref.set(planned, Option.some(turn))
        return { drafts: [...reap.drafts, starting], next: Option.some(next), result: { admitted, next, tookOver: reap.closed } }
      }), (opened) => Ref.set(unowned, Option.some(opened.admitted)).pipe(Effect.andThen(forgetOpened(address.id, opened.admitted.turn, opened.admitted.runId)))).pipe(
        // A store failure leaves the opening commit's outcome unknown (a stalled write may land later): the turn it would
        // open is let go of, so that if it did land, the next begin, deliver or drain here reaps it instead of finding it held.
        Effect.tapErrorTag("SessionLogError", () => Ref.get(planned).pipe(Effect.flatMap(Option.match({
          onNone: () => Effect.void,
          onSome: (turn) => letGo(address.id, turn, input.runId),
        })))),
        // A refused begin drops its plan's reap with it: a sealed turn its holder left is closed in a commit of its own, its reply stored.
        Effect.tapError(() => reapSealed(address, input.takeOver ?? false).pipe(
          Effect.ignore({ log: "Warn", message: "a sealed turn its holder left was not reaped after a refused begin; the next begin reaps it" }),
        )),
      )))
      // The opening plan always commits `turn.started`, last: neither can happen unless the log broke its contract.
      const committed = yield* Option.match(begun.committed, {
        onNone: () => Effect.die(new Error("the opening commit of a turn committed nothing")),
        onSome: Effect.succeed,
      })
      const started = yield* Option.match(Option.fromNullishOr(committed.events.at(-1)), {
        onNone: () => Effect.die(new Error("the log stored a turn's opening commit without its events")),
        onSome: Effect.succeed,
      })
      const turn = begun.result.admitted.turn
      // A turn taken over that this instance still held: its writer is closed now, not at its next write.
      yield* Option.match(begun.result.tookOver, { onNone: () => Effect.void, onSome: (taken) => closeLocal(address, "interrupted", Option.some(taken)) })
      // A writer that closed without storing its end (the store refused it, the scope's own try included) leaves the
      // turn open in the head under this instance: let it go, so it is not held here until the process exits.
      const letGoUnended = Ref.get(writers).pipe(Effect.flatMap((all) => Option.match(Option.fromNullishOr(all.get(writerKey(address))), {
        onNone: () => Effect.void,
        onSome: (open) => open.turn !== turn ? Effect.void : open.ended.pipe(Effect.flatMap((ended) => ended ? Effect.void : letGo(address.id, turn, open.writer.admitted.runId))),
      })))
      // Runs after the writer's own finalizers (last added, first run): the turn counts until its end is stored.
      yield* Effect.addFinalizer(() => letGoUnended.pipe(
        Effect.andThen(Ref.update(writers, (all) => new Map([...all].filter(([id, open]) => id !== writerKey(address) || open.turn !== turn)))),
        Effect.andThen(SubscriptionRef.update(inFlight, (now): InFlight => ({ ...now, held: new Map([...now.held].filter(([key]) => key !== heldKey(address.id, turn))) })))))
      const runId = begun.result.admitted.runId
      /** Completed once the writer's own commit leaves the turn closed (its end stored): the time limit stops then. */
      const ended = yield* Deferred.make<void>()
      const open = yield* makeTurnWriter({
        log, config, instance, header: begun.head.header, incarnation: begun.head.incarnation, admitted: begun.result.admitted, started,
        position: { revision: committed.revision, seq: committed.seq, state: begun.result.next, storageAt: committed.at },
        wake: (before, after) => remember(address, after).pipe(
          Effect.andThen(wake(address.id, waitingChanged(before, after))),
          Effect.andThen(Option.exists(after.open, (still) => still.turn === turn && still.runId === runId) ? Effect.void : Deferred.succeed(ended, undefined)),
        ),
      }, scope)
      yield* Ref.set(unowned, Option.none())
      yield* Ref.update(writers, (all) => new Map([...all, [writerKey(address), { ...open, turn, reference: address }]]))
      // Held from now (this process's Clock): the begin stops counting as it starts counting as open, in one update.
      const since = yield* Clock.currentTimeMillis
      yield* SubscriptionRef.update(inFlight, (now): InFlight => ({
        held: new Map([...now.held, [heldKey(address.id, turn), { session: address.id, turn, since }]]),
        beginning: now.beginning - 1,
      }))
      // The turn's time limit runs from now, until the turn ends, is closed from elsewhere, or its scope closes.
      const limitMs = input.timeLimitMs ?? config.turns.timeLimitMs
      const over = Effect.raceFirst(Deferred.await(ended), open.writer.closed.pipe(Effect.asVoid))
      yield* Effect.forkIn(Effect.raceFirst(Effect.sleep(limitMs).pipe(Effect.as(true)), over.pipe(Effect.as(false))).pipe(
        Effect.flatMap((due) => due ? closeForTimeLimit(address, turn, runId, limitMs) : Effect.void),
        Effect.annotateLogs(turnAttributes(begun.result.admitted)),
      ), scope)
      // Its opening commit landed before a shutdown that is now interrupting: it is closed as the others were.
      if ((yield* Ref.get(stopping)) === "interrupting") yield* closeForShutdown(address, turn, runId)
      return open
    }).pipe(Effect.onExit((exit) => Exit.isSuccess(exit) ? Effect.void
      // A begin that committed no turn stops counting now; one that did, once its scope has closed it.
      : Ref.get(unowned).pipe(Effect.flatMap((committed) => Option.isSome(committed) ? Effect.void : beginSettled))))
  }))

  /**
   * A user's message normalised once, before anything else: the key's
   * comparison with an earlier turn, the stored `turn.started` and
   * `admitted` all use this value, so a retry with the same images is the
   * same turn and memory takes exactly what was stored.
   */
  const normalized = (input: BeginTurn): Effect.Effect<BeginTurn, AttachmentRejected> => Match.valueTags(input, {
    User: (user) => normalizeUserMessage(user.userMessage).pipe(Effect.map((userMessage): BeginTurn => ({ ...user, userMessage }))),
    Task: (task) => normalizeUserMessage(task.userMessage).pipe(Effect.map((userMessage): BeginTurn => ({ ...task, userMessage }))),
    Inbox: (inbox) => Effect.succeed(inbox),
    Queued: (queued) => Effect.succeed(queued),
  })

  const begin = Effect.fn("sessions.begin")((address: SessionAddress, input: BeginTurn) => normalized(input).pipe(
    Effect.flatMap((ready) => openTurn(address, ready)),
    Effect.map((open) => open.writer),
  ), onSession)

  /** Close this instance's writer of a session, if it holds `turn` (or any turn). */
  const closeLocal = (reference: SessionRef, reason: ClosedBy, turn: Option.Option<number>) => Ref.get(writers).pipe(Effect.flatMap((all) =>
    Option.match(Option.fromNullishOr(all.get(writerKey(reference))), {
      onNone: () => Effect.void,
      onSome: (open) => Option.match(turn, { onNone: () => true, onSome: (wanted) => wanted === open.turn }) ? open.close(reason) : Effect.void,
    })))

  /**
   * Close the session's open turn `turn` as `ending` says, in one commit,
   * if it is still open, then this instance's writer of it: its inbox items
   * done (cancelled) or waiting again (interrupted; an attempt counted when
   * `tried`). A turn nobody holds any more is reaped instead, as by any
   * commit (interrupted, `turn.lease`): it is not open, so nothing is closed
   * and the outcome does not depend on which came first. The writer's
   * `TurnClosed` gives `closedBy`.
   */
  const closeOpen = (address: SessionAddress, turn: number, ending: { readonly reason: "cancelled" | "interrupted"; readonly failure: Option.Option<TurnFailure>; readonly tried: boolean; readonly closedBy: ClosedBy }) => owned(address).pipe(Effect.flatMap((head) => endSealedLocal(sessionRef(head), turn).pipe(Effect.flatMap(Option.match({
    // A sealed turn held here ends through its own writer: its held reply and drafts with its sealed ending.
    onSome: (stored) => Effect.succeed({ closed: true, pending: stored.pending }),
    onNone: () => guarded(sessionRef(head), (head, stored) => Effect.gen(function* () {
      const reap = yield* reaped(head, stored)
      const state = reap.state
      if (Option.isSome(reap.closed)) return { drafts: reap.drafts, next: Option.some(state), result: { closed: false, pending: pendingOf(state).length } }
      if (!Option.exists(state.open, (open) => open.turn === turn)) return { drafts: [], next: Option.none<SessionsState>(), result: { closed: false, pending: pendingOf(state).length } }
      // One sealed elsewhere (or whose writer could not store its end) ends as sealed, with the reply it sealed.
      const sealed = Option.flatMap(state.open, (open) => open.sealed)
      const closing: TurnEnding = Option.match(sealed, { onSome: (seal) => seal.ending, onNone: () => ({ reason: ending.reason, failure: ending.failure }) })
      const after = closedState(state, closing.reason, config.inbox.attempts, ending.tried)
      const draft = yield* turnEndedDraft(turn, closing).pipe(Effect.orDie)
      const dropped = yield* droppedDrafts(after.dropped, turn)
      return { drafts: [...sealedDrafts(sealed, turn), draft, ...dropped], next: Option.some(after.state), result: { closed: true, pending: pendingOf(after.state).length } }
    })).pipe(Effect.tap((done) => done.result.closed ? closeLocal(sessionRef(done.head), ending.closedBy, Option.some(turn)) : Effect.void), Effect.map((done) => done.result)),
  })))))

  /** End a sealed turn this instance holds through its own writer; none when it holds no sealed writer of it, or that end was not stored. */
  const endSealedLocal = (reference: SessionRef, turn: number) => Ref.get(writers).pipe(Effect.flatMap((all) => Option.match(Option.filter(Option.fromNullishOr(all.get(writerKey(reference))), (open) => open.turn === turn), {
    onNone: () => Effect.succeedNone,
    onSome: (open) => open.endSealed.pipe(
      Effect.tapError((error) => Effect.logWarning("a sealed turn's own end was not stored; its sealed state ends it instead", error)),
      Effect.orElseSucceed(() => Option.none<{ readonly pending: number }>()),
    ),
  })))

  /**
   * Close a turn this instance holds as interrupted with `failure`, an
   * attempt counted when `tried`, its writer closed with `closedBy` whatever
   * the store answers, so its body stops; an end not stored is logged, and
   * the turn is let go of, for the next begin or process to reap.
   */
  const interruptHeld = (address: SessionRef, turn: number, runId: string, failure: TurnFailure, tried: boolean, closedBy: ClosedBy) =>
    closeOpen(address, turn, { reason: "interrupted", failure: Option.some(failure), tried, closedBy }).pipe(
      Effect.asVoid,
      Effect.tapError(() => letGo(address.id, turn, runId).pipe(Effect.andThen(closeLocal(address, closedBy, Option.some(turn))))),
      Effect.ignore({ log: "Warn", message: `a turn closed with ${failure.code} did not store its end; this instance lets it go, for the next begin or process to reap` }),
      Effect.annotateLogs(sessionAttributes(address.id)),
    )

  /** Close a turn this instance holds for a shutdown: `turn.shutdown`, no attempt counted (the items it took were not why it stopped). */
  const closeForShutdown = (address: SessionRef, turn: number, runId: string) =>
    interruptHeld(address, turn, runId, { code: "turn.shutdown", message: "the process shut down before the turn ended" }, false, "interrupted")

  /**
   * Close a turn this instance holds once it ran `limitMs`: `turn.time-limit`,
   * an attempt counted (the items it took may be why it ran so long), its
   * writer's `TurnClosed` `timed-out`.
   */
  const closeForTimeLimit = (address: SessionRef, turn: number, runId: string, limitMs: number) =>
    interruptHeld(address, turn, runId, { code: "turn.time-limit", message: `the turn ran past its time limit of ${limitMs} ms` }, true, "timed-out")

  const shutdown = TurnShutdown.of({
    refuse: Ref.update(stopping, (now) => now === "running" ? "refusing" : now),
    stopping: Ref.get(stopping).pipe(Effect.map((now) => now !== "running")),
    interrupt: Effect.gen(function* () {
      yield* Ref.set(stopping, "interrupting")
      const held = [...(yield* SubscriptionRef.get(inFlight)).held.values()].sort((left, right) => left.since - right.since)
      const all = yield* Ref.get(writers)
      // The turns held now whose writer this instance still has: one whose scope is closing ended already.
      const open = held.flatMap((active) => Option.toArray(Option.filter(Option.fromNullishOr([...all.values()].find((writer) => writer.reference.id === active.session && writer.turn === active.turn)), (writer) => writer.turn === active.turn))
        .map((writer) => ({ active, address: writer.reference, runId: writer.writer.admitted.runId })))
      yield* Effect.forEach(open, ({ active, address, runId }) => closeForShutdown(address, active.turn, runId), { concurrency: 4, discard: true })
      return open.map(({ active }) => active)
    }),
  })

  const drain = Effect.fn("sessions.drain")(function* <E, R>(address: SessionAddress, run: (writer: TurnWriter) => Effect.Effect<void, E, R>, options?: { readonly maxTurns?: number; readonly meta?: JsonObject; readonly takeOver?: boolean; readonly timeLimitMs?: number; readonly take?: "all" | "inputs" | "notices" }): Effect.fn.Return<{ readonly turns: number }, SessionMissing | SessionContended | SessionLogError, R> {
    const maxTurns = options?.maxTurns ?? 3
    const meta = options?.meta
    const take = options?.take ?? "all"
    const selected = (slot: SessionsState["inbox"][number]): boolean => take === "all" || (take === "inputs" ? slot.delivery !== undefined : slot.delivery === undefined)
    // The session the drain resolved first, its incarnation included: every turn it opens, and every candidate it picks, is of that session, never of one created again under its id meanwhile.
    const reference = sessionRef(yield* owned(address))
    const hasWaiting = owned(reference).pipe(Effect.flatMap((head) => stateOf(head).pipe(Effect.mapError(storage("session.state")))),
      Effect.map((state) => pendingOf(state).some(selected)))
    /**
     * What an inbox turn is begun with besides its run id and `meta`, written
     * only when given: `takeOver` for the first turn alone, the one that
     * replaces the holder the host knows is gone. A turn opened between the
     * drain's own turns is someone's live work, never taken over.
     */
    const begunWith = (first: boolean) => ({
      ...(first && options?.takeOver === true ? { takeOver: true } : {}),
      ...(options?.timeLimitMs === undefined ? {} : { timeLimitMs: options.timeLimitMs }),
    })
    /** One inbox turn, if one opens: then whether items still wait after it. */
    const once = (first: boolean): Effect.Effect<Option.Option<boolean>, SessionMissing | SessionContended | SessionLogError, R> => Effect.scoped(Effect.gen(function* () {
      const runId = RunId.make(yield* Effect.sync(() => crypto.randomUUID()))
      const begun = begunWith(first)
      const head = yield* owned(reference)
      const state = yield* stateOf(head).pipe(Effect.mapError(storage("session.state")))
      const held = yield* heldTurn(head, state, holder)
      const available = Option.isNone(held) || begun.takeOver === true ? state.inbox : pendingOf(state)
      const candidate = available.find(selected)
      if (candidate === undefined) return Option.none<boolean>()
      const input: BeginTurn = candidate.delivery === undefined ? { _tag: "Inbox", runId, ...begun, ...(meta === undefined ? {} : { meta }) }
        : { _tag: "Queued", input: candidate.id, runId, ...begun, ...(meta === undefined ? {} : { meta }) }
      const open = yield* openTurn(reference, input)
      // A TurnError carried as a defect keeps its own tag and code, as in `Agent.turn`.
      const exit = yield* Effect.exit(harnessDefectsAsFailures(run(open.writer)))
      // The turn ends with what ended `run`: its error's code, `turn.defect` or `turn.interrupted`.
      const callbackEnding = turnEndingOf(Exit.map(exit, () => ({ outcome: "completed" as const })))
      const ending = Exit.isSuccess(exit) ? Option.getOrElse(yield* open.replyEnding, () => callbackEnding) : callbackEnding
      // A drain interrupted from outside stops before this line, so an interruption here is `run`'s own: it counts
      // an attempt even when `run` wrote nothing, so an item whose run keeps interrupting itself is still dropped.
      if (ending.reason === "interrupted") yield* open.markTried
      const ids = turnAttributes(open.writer.admitted)
      yield* Option.match(ending.failure, {
        onNone: () => Effect.void,
        onSome: (failure) => Effect.logWarning(`an inbox turn ended ${ending.reason}: ${failure.code}`).pipe(Effect.annotateLogs(ids)),
      })
      // The drain closes its own turns, so it drains what they leave: its end counts what waits (items delivered
      // during the turn included). An end not stored is logged, and the drain goes on: the scope tries the end
      // again, and lets the turn go when that fails too, so the next begin reaps it and takes its items again.
      const unstored = "an inbox turn did not store its end"
      return yield* open.writer.end(ending).pipe(
        Effect.andThen(hasWaiting),
        Effect.map(Option.some),
        Effect.catchTag("TurnClosed", (closed) => Effect.logDebug(`${unstored}: the turn was ${closed.reason}`).pipe(Effect.as(Option.some(true)))),
        Effect.catch((error) => Effect.logWarning(`${unstored}: ${reasonOf(Cause.fail(error))}`).pipe(Effect.as(Option.some(true)))),
        Effect.annotateLogs(ids),
      )
    })).pipe(
      Effect.catchTags({
        NothingPending: () => Effect.succeedNone,
        SessionBusy: () => Effect.succeedNone,
        TurnDuplicate: () => Effect.succeedNone,
        KeyConflict: () => Effect.succeedNone,
        // Each inbox turn's run id is new: never raised here.
        RunIdReused: () => Effect.succeedNone,
        // An inbox turn resumes nothing: never raised here.
        NotResumable: () => Effect.succeedNone,
        TurnRefused: (refused) => Effect.logWarning(`an inbox turn was refused: ${refused.message}`).pipe(Effect.as(Option.none<boolean>())),
      }),
    )
    const loop = (turns: number): Effect.Effect<{ readonly turns: number }, SessionMissing | SessionContended | SessionLogError, R> =>
      turns >= maxTurns ? Effect.succeed({ turns }) : once(turns === 0).pipe(Effect.flatMap(Option.match({
        onNone: () => Effect.succeed({ turns }),
        onSome: (more) => more ? loop(turns + 1) : Effect.succeed({ turns: turns + 1 }),
      })))
    return yield* loop(0)
  }, onSession)

  const activity = TurnActivity.of({
    current: SubscriptionRef.get(inFlight).pipe(Effect.map((now) => ({
      open: [...now.held.values()].sort((left, right) => left.since - right.since),
      beginning: now.beginning,
    }))),
    idle: SubscriptionRef.changes(inFlight).pipe(Stream.filter((now) => now.held.size === 0 && now.beginning === 0), Stream.take(1), Stream.runDrain),
  })

  const cached = Ref.get(known).pipe(Effect.map((now): ReadonlyArray<WaitingInputCount> => HashMap.toValues(now.waiting)
    .filter((item) => item.pending > 0).map(({ address, pending }) => ({ session: address.id, pending }))))
  const current = Effect.gen(function* () {
    const now = yield* Ref.get(known)
    const addresses = [...HashMap.toValues(now.waiting).map(({ address }) => address), ...now.quiet]
    return (yield* Effect.forEach(addresses, (address) => owned(address).pipe(
      Effect.flatMap(stateFrom),
      Effect.map((state): ReadonlyArray<WaitingInputCount> => {
        const pending = pendingOf(state).filter((slot) => slot.delivery !== undefined).length
        return pending > 0 ? [{ session: address.id, pending }] : []
      }),
      Effect.catchTag("SessionMissing", () => forget(address).pipe(Effect.as<ReadonlyArray<WaitingInputCount>>([]))),
    ), { concurrency: 1 })).flat()
  })
  const idle = Effect.scoped(Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(waitingHub)
    const settled: Effect.Effect<void, SessionLogError> = current.pipe(Effect.flatMap((counts) => counts.length === 0 ? Effect.void
      : Effect.raceFirst(PubSub.take(subscription), Effect.sleep(config.inbox.pollIntervalMs ?? 100)).pipe(Effect.andThen(settled))))
    yield* settled
  }))
  const waiting = WaitingInput.of({ current, cached, idle })

  // Each call but `changes` is a `sessions.<op>` span, with the session's id (`efferent.session.id`) on it and on its logs.
  return Context.make(TurnActivity, activity).pipe(Context.add(TurnShutdown, shutdown), Context.add(WaitingInput, waiting), Context.add(Sessions, Sessions.of({
    create: Effect.fn("sessions.create")(function* (input) {
      const id = input.id ?? (yield* freshId)
      yield* Effect.annotateCurrentSpan(sessionAttributes(id))
      // Created without a parent: a log that answers `SessionMissing` broke its contract.
      const header = {
        id, owner: input.owner, origin: input.origin ?? "user",
        createdAt: yield* Clock.currentTimeMillis, meta: input.meta ?? {}, parent: Option.none(),
      }
      const head = yield* log.create({ header, state: yield* stateJson(initialState({ header })).pipe(Effect.orDie) }).pipe(
        Effect.catchTag("SessionMissing", Effect.die),
        Effect.tap((created) => observe({ id: created.header.id, owner: created.header.owner }).pipe(Effect.andThen(wake(created.header.id, true)))),
        Effect.uninterruptible,
      )
      return yield* viewFrom(head)
    }),
    fork: Effect.fn("sessions.fork")(function* (parent, input) {
      // A fork of a newer release's session would carry its records into a session this release writes.
      const parentHead = yield* owned(parent)
      const reference = sessionRef(parentHead)
      const endings = input.inherit ? yield* log.read(reference, { after: 0, limit: Option.none(), kinds: ["turn.ended"] }) : []
      const last = Option.fromNullishOr(endings.at(-1))
      const header = {
        id: input.id ?? (yield* freshId), owner: parent.owner, origin: input.origin,
        createdAt: yield* Clock.currentTimeMillis, meta: input.meta ?? {},
        parent: Option.some({
          ...reference,
          through: Option.match(last, { onNone: () => 0, onSome: (event) => event.seq }),
          turnAtFork: Option.match(last, { onNone: () => 0, onSome: (event) => Option.getOrElse(event.turn, () => 0) }),
        }),
      }
      const head = yield* log.create({ header, state: yield* stateJson(initialState({ header })).pipe(Effect.orDie) }).pipe(
        Effect.tap((created) => observe({ id: created.header.id, owner: created.header.owner }).pipe(Effect.andThen(wake(created.header.id, true)))),
        Effect.uninterruptible,
      )
      return yield* viewFrom(head)
    }, onSession),
    get: Effect.fn("sessions.get")((address) => owned(address).pipe(Effect.flatMap(viewFrom)), onSession),
    list: Effect.fn("sessions.list")(function* (query) {
      const limit = query.limit ?? 50
      const parent = query.parent === undefined ? Option.none<SessionRef>() : yield* owned({ id: query.parent, owner: query.owner }).pipe(Effect.map((head) => Option.some(sessionRef(head))), Effect.catchTag("SessionMissing", () => Effect.succeedNone))
      if (query.parent !== undefined && Option.isNone(parent)) return { sessions: [], next: Option.none() }
      const heads = yield* log.list({
        owner: query.owner, limit, before: Option.fromNullishOr(query.before), parent,
      })
      const sessions = yield* Effect.forEach(heads, (head) => refuseUnsupported(head).pipe(Effect.andThen(viewFrom(head))), { concurrency: 1 })
      const last = Option.fromNullishOr(heads.at(-1))
      return {
        sessions,
        next: heads.length < limit ? Option.none() : Option.map(last, (head) => ({ updatedAt: head.updatedAt, id: head.header.id })),
      }
    }),
    remove: Effect.fn("sessions.remove")(function* (address) {
      const head = yield* owned(address)
      const reference = sessionRef(head)
      yield* Effect.uninterruptible(Effect.gen(function* () {
        yield* log.remove(reference)
        yield* Ref.update(released, (all) => new Map([...all].filter(([session]) => session !== address.id)))
        yield* forget(address)
        yield* closeLocal(reference, "removed", Option.none())
        yield* wake(address.id, true)
      }))
    }, onSession),
    read: Effect.fn("sessions.read")((address, query) => owned(address).pipe(Effect.flatMap((head) => log.read(sessionRef(head), {
      after: query?.after ?? 0, limit: Option.fromNullishOr(query?.limit), kinds: query?.kinds ?? [],
      ...(query?.from === undefined ? {} : { from: query.from }),
    }))), onSession),
    waiting: Stream.unwrap(PubSub.subscribe(waitingHub).pipe(Effect.map((subscription) => Stream.concat(Stream.succeed(undefined), Stream.fromSubscription(subscription))))),
    changes: (address) => Stream.unwrap(RcMap.get(followers, address.id).pipe(Effect.map(Stream.fromPubSub))),
    lookup: Effect.fn("sessions.lookup")((address, key) => owned(address).pipe(Effect.flatMap((head) => keyed(sessionRef(head), key)), Effect.map(Option.map((found) => found.turn))), onSession),
    transact,
    // A turn nobody holds any more is reaped, as by a begin or a delivery, whichever comes first: it is not open, so the
    // cancel cancels nothing, and the outcome (interrupted, its items waiting again) does not depend on the order.
    cancel: Effect.fn("sessions.cancel")((address, turn) => closeOpen(address, turn, { reason: "cancelled", failure: Option.none(), tried: true, closedBy: "cancelled" }).pipe(
      Effect.map((done) => ({ cancelled: done.closed, pending: done.pending })),
    ), onSession),
    begin,
    enqueue: Effect.fn("sessions.enqueue")(function* (address, input) {
      const userMessage = yield* normalizeUserMessage(input.userMessage)
      const ready: QueuedInput = { ...input, userMessage }
      return yield* guarded(address, (head, stored) => Effect.gen(function* () {
        const reap = yield* reaped(head, stored)
        const state = reap.state
        const earlier = (yield* queuedIn(sessionRef(head))).find(({ data }) => data.id === ready.id)
        if (earlier !== undefined) {
          const previous = earlier.data
          if (previous.input === undefined || !sameUserMessage(previous.input.userMessage, ready.userMessage)
            || previous.input.delivery !== ready.delivery || canonicalJson(previous.source) !== canonicalJson(ready.source)) {
            return yield* Effect.fail(new InputConflict({ session: address.id, id: ready.id }))
          }
          return {
            drafts: reap.drafts, next: reap.drafts.length === 0 ? Option.none<SessionsState>() : Option.some(state),
            result: { enqueued: false, pending: pendingOf(state).length },
            validateRead: true,
          }
        }
        if (pendingOf(state).length >= config.inbox.maxPending) return yield* Effect.fail(new InboxFull({ session: address.id, pending: pendingOf(state).length }))
        const next: SessionsState = { ...state, inbox: [...state.inbox, { id: ready.id, delivery: ready.delivery, attempts: 0, claimedBy: Option.none() }] }
        const data = yield* queuedInputData(ready).pipe(Effect.orDie)
        return {
          drafts: [...reap.drafts, { kind: "inbox.queued", turn: Option.none(), data }], next: Option.some(next),
          result: { enqueued: true, pending: pendingOf(next).length },
        }
      })).pipe(Effect.map((done) => done.result))
    }, onSession),
    deliver: Effect.fn("sessions.deliver")((address, item) => guarded(address, (head, stored) => Effect.gen(function* () {
      const reap = yield* reaped(head, stored)
      const state = reap.state
      const reapedOnly = { drafts: reap.drafts, next: reap.drafts.length === 0 ? Option.none<SessionsState>() : Option.some(state) }
      if (state.inbox.some((slot) => slot.id === item.id)) return { ...reapedOnly, result: { delivered: false, pending: pendingOf(state).length } }
      const earlier = yield* queuedIn(sessionRef(head))
      if (earlier.some((queued) => queued.data.id === item.id)) return { ...reapedOnly, result: { delivered: false, pending: pendingOf(state).length } }
      if (pendingOf(state).length >= config.inbox.maxPending) return yield* Effect.fail(new InboxFull({ session: address.id, pending: pendingOf(state).length }))
      const next: SessionsState = { ...state, inbox: [...state.inbox, { id: item.id, attempts: 0, claimedBy: Option.none() }] }
      const queued = yield* queuedData(item).pipe(Effect.orDie)
      return {
        drafts: [...reap.drafts, { kind: "inbox.queued", turn: Option.none(), data: queued }],
        next: Option.some(next),
        result: { delivered: true, pending: pendingOf(next).length },
      }
    })).pipe(Effect.map((done) => done.result)), onSession),
    drain,
  })))
}))
