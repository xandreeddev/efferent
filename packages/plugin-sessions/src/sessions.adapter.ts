import { Cause, Clock, Context, Effect, Equal, Exit, Layer, Match, Option, PubSub, RcMap, Ref, Schema, Scope, Stream, SubscriptionRef } from "effect"
import {
  canonicalJson,
  ConversationId,
  EntryId,
  HarnessError,
  harnessDefectsAsFailures,
  InboxFull,
  isRevisionConflict,
  KeyConflict,
  normalizeUserMessage,
  NothingPending,
  NotResumable,
  reasonOf,
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
  TurnActivity,
  TurnAdmission,
  TurnDuplicate,
  turnEndedDraft,
  turnEndedOf,
  turnEndingOf,
  turnStartedDraft,
  turnStartedOf,
  turnAttributes,
  TurnShutdown,
  UserMessage,
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
  ResumableTurn,
  RevisionConflict,
  SessionAddress,
  SessionCommitted,
  SessionDraft,
  SessionHead,
  SessionLogEvent,
  SessionView,
  TaskRef,
  TurnDraft,
  TurnFailure,
  TurnOrigin,
  TurnWriter,
} from "@xandreed/core"
import { processLiveness } from "./process-liveness.adapter.js"
import { closedState, droppedData, heldTurn, isNewerFormat, pendingOf, queuedData, stateJson, stateOf, storedFormatOf, titleOf, viewOf, withFormat } from "./sessions-state.entity.functions.js"
import type { Holder } from "./sessions-state.entity.functions.js"
import { Ownership } from "./sessions-state.entity.js"
import type { HeldTurn, ProcessLiveness, SessionsConfig, SessionsState } from "./sessions-state.entity.js"
import { makeTurnWriter } from "./turn-writer.adapter.js"
import type { OpenWriter } from "./turn-writer.adapter.js"
import type { ClosedBy } from "./turn-writer.entity.js"

/** One commit outside a turn: what to append and the state after it (nothing, to commit nothing). */
interface GuardedPlan<A> {
  readonly drafts: ReadonlyArray<SessionDraft>
  readonly next: Option.Option<SessionsState>
  readonly result: A
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
}

/** A begin as `Asked`: a user's and a task's turn are keyed by their caller, an inbox turn by its run id. */
const askedOf = (input: BeginTurn): Asked => Match.valueTags(input, {
  User: (user): Asked => ({
    origin: "user", key: user.key, userMessage: Option.some(user.userMessage), command: user.command,
    resumes: Option.fromNullishOr(user.resumes), task: Option.none(),
  }),
  Inbox: (inbox): Asked => ({ origin: "inbox", key: inbox.runId, userMessage: Option.none(), command: {}, resumes: Option.none(), task: Option.none() }),
  Task: (task): Asked => ({
    origin: "task", key: task.key, userMessage: Option.some(task.userMessage), command: {}, resumes: Option.none(), task: Option.some(task.task),
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
export const SessionsLive = (config: SessionsConfig, options?: { readonly liveness?: ProcessLiveness }): Layer.Layer<Sessions | TurnActivity | TurnShutdown, HarnessError, SessionLog | TurnAdmission> => Layer.effectContext(Effect.gen(function* () {
  yield* Schema.decodeUnknownEffect(Ownership)(config.ownership).pipe(
    Effect.mapError((error) => new HarnessError({ code: "config.options", plugin: "@xandreed/plugin-sessions", message: `ownership: ${error.message}` })))
  const log = yield* SessionLog
  const admission = yield* TurnAdmission
  const ownership = config.ownership
  const instance = yield* Effect.sync(() => crypto.randomUUID())
  const liveness = options?.liveness ?? processLiveness
  /** Per session, the turn this instance's writer let go of without storing its end: held by nobody from then on. */
  const released = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
  const holder: Holder = {
    instance,
    liveness,
    // Named whatever this instance's ownership: a turn another took under process ownership is judged by its process.
    process: yield* liveness.current,
    released: (session) => Ref.get(released).pipe(Effect.map((all) => Option.fromNullishOr(all.get(session)))),
  }
  /** Let go of a turn this instance opened whose end was not stored, so the next begin, deliver or drain here reaps it. */
  const letGo = (id: string, turn: number) => Ref.update(released, (all) => new Map([...all, [id, turn]]))
  /** Forget a turn let go of once a commit leaves the session without it open. */
  const forgetClosed = (id: string, next: SessionsState) => Ref.update(released, (all) => Option.match(Option.fromNullishOr(all.get(id)), {
    onNone: () => all,
    onSome: (turn) => Option.exists(next.open, (open) => open.turn === turn) ? all : new Map([...all].filter(([session]) => session !== id)),
  }))
  /**
   * Per followed session, one hub of change signals: sliding with room for
   * one, so a follower that does not pull holds one signal however many
   * commits it missed, and never loses the last. Held while someone follows
   * the session (`RcMap` releases it with the last follower), so a commit to
   * a session nobody follows signals nothing and keeps nothing.
   */
  const followers = yield* RcMap.make({ lookup: (_: ConversationId) => Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown) })
  /** The writer this instance holds per session, for a local cancel or removal. */
  const writers = yield* Ref.make(new Map<string, OpenWriter & { readonly turn: number }>())
  const inFlight = yield* SubscriptionRef.make<InFlight>({ held: new Map(), beginning: 0 })
  /** Where this instance is in a shutdown: running, refusing every begin, or also closing every turn it holds. */
  const stopping = yield* Ref.make<"running" | "refusing" | "interrupting">("running")
  const refuseIfStopping = (address: SessionAddress) => Ref.get(stopping).pipe(Effect.flatMap((now) => now === "running" ? Effect.void : Effect.fail(shutdownRefusal(address.id))))
  const heldKey = (id: string, turn: number) => `${id}:${turn}`
  const beginSettled = SubscriptionRef.update(inFlight, (now): InFlight => ({ ...now, beginning: now.beginning - 1 }))
  /** Signal the session's followers, if it has any. */
  const wake = (id: ConversationId) => RcMap.getOption(followers, id).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (hub) => PubSub.publish(hub, undefined).pipe(Effect.asVoid) })),
    Effect.scoped,
  )
  const freshId = Effect.sync(() => ConversationId.make(crypto.randomUUID()))

  const stateFrom = (head: SessionHead) => stateOf(head).pipe(Effect.mapError(storage("session.state")))
  /**
   * A session a newer release wrote (its stored format above this
   * release's) is refused for writes and turns before anything is planned:
   * this release cannot tell what that release's records mean, and must not
   * write its own beside them. Reads are not refused.
   */
  const refuseNewer = (head: SessionHead) => storedFormatOf(head).pipe(
    Effect.mapError(storage("session.state")),
    Effect.flatMap((format) => isNewerFormat(format)
      ? Effect.fail(new SessionLogError({ code: "session.version", message: `the session holds stored format ${format}, written by a newer release; this release reads up to ${STORED_FORMAT}` }))
      : Effect.void),
  )
  const owned = (address: SessionAddress) => log.head(address.id).pipe(Effect.flatMap((head) =>
    head.header.owner === address.owner ? Effect.succeed(head) : Effect.fail(new SessionMissing({ session: address.id }))))
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
  const guarded = <A, E>(address: SessionAddress, plan: (head: SessionHead, state: SessionsState) => Effect.Effect<GuardedPlan<A>, E>, stored: (result: A) => Effect.Effect<void> = () => Effect.void): Effect.Effect<Guarded<A>, E | SessionMissing | SessionContended | SessionLogError> => {
    const once: Effect.Effect<Guarded<A>, E | SessionMissing | RevisionConflict | SessionLogError> = Effect.gen(function* () {
      const head = yield* owned(address)
      yield* refuseNewer(head)
      const held = yield* stateFrom(head)
      const current = withFormat(held)
      const planned = yield* plan(head, current)
      if (planned.drafts.length === 0 && Option.isNone(planned.next)) return { result: planned.result, head, committed: Option.none() }
      const next = Option.orElse(planned.next, () => current === held ? Option.none() : Option.some(current))
      const state = yield* Option.match(next, {
        onNone: () => Effect.succeedNone,
        onSome: (written) => stateJson(written).pipe(Effect.map(Option.some), Effect.orDie),
      })
      const outcome = yield* Effect.uninterruptible(Effect.result(log.commit(address.id, {
        expect: head.revision, notAfter: Option.none(), events: planned.drafts, state,
      })).pipe(Effect.tap((result) => result._tag === "Success" ? stored(planned.result) : Effect.void)))
      if (outcome._tag === "Success") {
        yield* Option.match(planned.next, { onNone: () => Effect.void, onSome: (after) => forgetClosed(address.id, after) })
        yield* wake(address.id)
        return { result: planned.result, head, committed: Option.some(outcome.success) }
      }
      const error = outcome.failure
      // A conflict fails this attempt as it is, for the retry below. The commit has no `notAfter`: a log that says it expired broke its contract.
      return yield* (error._tag === "LeaseExpired" ? Effect.die(error) : Effect.fail(error))
    })
    return once.pipe(
      Effect.retry({ times: config.retries - 1, while: isRevisionConflict }),
      Effect.catchIf(isRevisionConflict, () => Effect.fail(new SessionContended({ session: address.id, attempts: config.retries }))),
    )
  }

  /**
   * An open turn nobody holds any more (its lease ran out, or its process is
   * gone) is closed as interrupted: the drafts that close it, the state
   * after them, and the turn they close. With `takeOver`, the host's word
   * that its holder is gone, the open turn is closed so whoever holds it,
   * with code `turn.takeover`, and no attempt is counted: the items it took
   * were not the reason it stopped.
   */
  const reaped = (head: SessionHead, state: SessionsState, takeOver = false) => Effect.gen(function* () {
    if (Option.isNone(state.open) || (!takeOver && Option.isSome(yield* heldTurn(head, state, holder)))) return { drafts: [] as ReadonlyArray<SessionDraft>, state, closed: Option.none<number>() }
    const turn = state.open.value.turn
    const taken = takeOver && Option.isSome(yield* heldTurn(head, state, holder))
    // A reaped turn counts as an attempt: its holder may have stopped on the items. One taken over does not.
    const after = closedState(state, "interrupted", config.inbox.attempts, !taken)
    const closing = yield* turnEndedDraft(turn, {
      reason: "interrupted",
      failure: Option.some(taken
        ? { code: "turn.takeover", message: "a new holder took the session over" }
        : { code: "turn.lease", message: "the turn's holder stopped writing" }),
    }).pipe(Effect.orDie)
    const dropped = yield* droppedDrafts(after.dropped, turn)
    return { drafts: [closing, ...dropped], state: after.state, closed: Option.some(turn) }
  })

  /** A session's own `turn.started` events. */
  const startsOf = (id: ConversationId) => log.read(id, { after: 0, limit: Option.none(), kinds: ["turn.started"] })

  /** Of these `turn.started` events (their keys decoded, never the message), the turn begun with `key`, and what it was begun with. */
  const keyIn = (starts: ReadonlyArray<SessionLogEvent>, key: string) => readStoredKeys("turn.started", starts).pipe(
    Effect.map((keyed) => Option.map(Option.fromNullishOr(keyed.find((started) => started.keys.key === key)), ({ event }) => ({ turn: Option.getOrElse(event.turn, () => 0), event }))),
    Effect.mapError(storage("session.decode")),
  )

  /** The turn begun with `key`, and what it was begun with. */
  const keyed = (id: ConversationId, key: string) => startsOf(id).pipe(Effect.flatMap((starts) => keyIn(starts, key)))

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
      onSome: (parent) => parent.through <= 0 ? Effect.succeed(Option.none()) : startsOf(parent.id).pipe(
        Effect.flatMap((events) => begunIn(events, parent.through)),
        Effect.flatMap(Option.match({
          onSome: (turn) => Effect.succeed(Option.some(turn)),
          onNone: () => log.head(parent.id).pipe(Effect.flatMap((head) => inherited(head.header.parent))),
        }))),
    })
    return begunIn(starts, Number.POSITIVE_INFINITY).pipe(Effect.flatMap(Option.match({ onSome: (turn) => Effect.succeed(Option.some(turn)), onNone: () => inherited(header.parent) })))
  }

  /**
   * The session's own turns, each as begun (with the turn it resumed) and as
   * ended (when it was), for a resume's check; `reapedNow`, a turn this
   * commit closes as interrupted, counts as ended so.
   */
  const turnsOf = (id: ConversationId, reapedNow: Option.Option<number>) => log.read(id, { after: 0, limit: Option.none(), kinds: ["turn.started", "turn.ended"] }).pipe(
    Effect.flatMap((events) => Effect.gen(function* () {
      const numbered = (event: SessionLogEvent) => Option.getOrElse(event.turn, () => 0)
      const endings = new Map(yield* Effect.forEach(events.filter((event) => event.kind === "turn.ended"), (event) =>
        turnEndedOf(event).pipe(Effect.map((ended) => [numbered(event), ended.reason] as const)), { concurrency: 1 }))
      return yield* Effect.forEach(events.filter((event) => event.kind === "turn.started"), (event) => turnStartedOf(event).pipe(Effect.map((started): ResumableTurn => ({
        turn: numbered(event),
        origin: started.origin,
        resumes: Option.fromNullishOr(started.resumes),
        ended: Option.contains(reapedNow, numbered(event)) ? Option.some("interrupted") : Option.fromNullishOr(endings.get(numbered(event))),
      }))), { concurrency: 1 })
    }).pipe(Effect.mapError(storage("session.decode")))),
  )

  /** The session's `inbox.queued` records, decoded. */
  const queuedIn = (id: ConversationId) => log.read(id, { after: 0, limit: Option.none(), kinds: ["inbox.queued"] }).pipe(
    Effect.flatMap((events) => readStored("inbox.queued", events).pipe(Effect.mapError(storage("session.decode")))),
  )

  /** The inbox items with these ids, as delivered. */
  const inboxItems = (id: ConversationId, ids: ReadonlyArray<InboxItemId>) => queuedIn(id).pipe(
    Effect.map((queued) => ids.flatMap((wanted): ReadonlyArray<InboxItem> => Option.toArray(Option.fromNullishOr(queued.find((item) => item.data.id === wanted))).map(({ data }) => ({
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
    Effect.tapError(() => letGo(address.id, admitted.turn)),
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
  const openTurn = (address: SessionAddress, input: BeginTurn) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const scope = yield* Effect.scope
    const at = yield* Clock.currentTimeMillis
    const meta = input.meta ?? {}
    const asked = askedOf(input)
    const { key, origin, resumes } = asked
    // `resumes` is typed only as a number: one that is not a whole number of at least 1 names no turn, refused before the host's admission sees it.
    const unnumbered = Option.filter(resumes, (turn) => !(Number.isSafeInteger(turn) && turn >= 1))
    if (Option.isSome(unnumbered)) return yield* Effect.fail(new NotResumable({ session: address.id, turn: unnumbered.value, reason: "missing" }))
    // Written only when given, like `meta`: a turn that resumes nothing, or runs no task, is stored and admitted as before.
    const resuming = Option.match(resumes, { onNone: () => ({}), onSome: (turn) => ({ resumes: turn }) })
    const tasked = Option.match(asked.task, { onNone: () => ({}), onSome: (task) => ({ task }) })
    const toAdmit = { session: address, origin, runId: input.runId, key, meta, ...resuming, ...tasked }
    /** The turn the opening commit stored, until its writer is handed over. */
    const unowned = yield* Ref.make(Option.none<AdmittedTurn>())
    yield* SubscriptionRef.update(inFlight, (now): InFlight => ({ ...now, beginning: now.beginning + 1 }))
    yield* Scope.addFinalizerExit(scope, (exit) => Ref.get(unowned).pipe(Effect.flatMap(Option.match({
      onNone: () => Effect.void,
      onSome: (admitted) => unhanded(address, admitted, exit).pipe(Effect.ensuring(beginSettled)),
    }))))
    return yield* Effect.gen(function* () {
      // Refused before the host's admission is asked, and again in the plan: a begin past this check while a shutdown starts opens nothing.
      yield* refuseIfStopping(address)
      // Only the opening commit is admitted: the writer's later commits run outside the host's admission.
      const begun = yield* restore(admission.admit(toAdmit, guarded(address, (head, stored) => Effect.gen(function* () {
        yield* refuseIfStopping(address)
        const reap = yield* reaped(head, stored, input.takeOver ?? false)
        const state = reap.state
        const starts = yield* startsOf(address.id)
        // A turn that brings its message (a user's, a task's) is keyed by its caller: the key's earlier turn is this one or a conflict.
        if (Option.isSome(asked.userMessage)) {
          const brought = asked.userMessage.value
          const previous = yield* keyIn(starts, key)
          if (Option.isSome(previous)) {
            const started = yield* turnStartedOf(previous.value.event).pipe(Effect.mapError(storage("session.decode")))
            // The key's fingerprint is the message, the command, the turn resumed and the task, never `meta`: a retry with other metadata is the same turn.
            const same = sameUserMessage(started.userMessage, brought) && canonicalJson(started.command) === canonicalJson(asked.command)
              && Equal.equals(Option.fromNullishOr(started.resumes), resumes)
              && canonicalJson(started.task ?? null) === canonicalJson(Option.getOrNull(asked.task))
            return yield* Effect.fail(same
              ? new TurnDuplicate({ session: address.id, turn: previous.value.turn, open: Option.exists(state.open, (open) => open.turn === previous.value.turn) })
              : new KeyConflict({ session: address.id, key, turn: previous.value.turn }))
          }
        }
        // A run id names one turn's run: a begin reusing one (a retry under a new key, say) is refused before it opens anything.
        const reused = yield* runOf(head.header, starts, input.runId)
        if (Option.isSome(reused)) return yield* Effect.fail(new RunIdReused({ session: address.id, runId: input.runId, turn: reused.value }))
        if (Option.isSome(state.open)) return yield* Effect.fail(new SessionBusy({ session: address.id, turn: state.open.value.turn }))
        // A resume is checked in the commit that opens it, against the turns as stored (a turn reaped by this commit is interrupted).
        if (Option.isSome(resumes)) {
          const refusal = resumeRefusal(resumes.value, yield* turnsOf(address.id, reap.closed))
          if (Option.isSome(refusal)) return yield* Effect.fail(new NotResumable({ session: address.id, turn: resumes.value, reason: refusal.value }))
        }
        // An inbox turn takes every item waiting, and its message is theirs.
        const waiting = origin === "inbox" ? pendingOf(state).map((slot) => slot.id) : []
        if (origin === "inbox" && waiting.length === 0) return yield* Effect.fail(new NothingPending({ session: address.id }))
        const claimed = yield* inboxItems(address.id, waiting)
        const userMessage = Option.getOrElse(asked.userMessage, () => new UserMessage({ text: claimed.map((item) => item.content).join("\n\n") }))
        const turn = state.turns + 1
        const open: HeldTurn = {
          turn, runId: input.runId, key, origin, holder: instance,
          expiresAt: ownership.mode === "lease" ? Option.some(head.now + ownership.ttlMs) : Option.none(),
          process: ownership.mode === "process" ? holder.process : Option.none(),
        }
        const next: SessionsState = {
          ...state,
          turns: turn,
          open: Option.some(open),
          // A session is titled by the first message a user or a task brought.
          title: Option.orElse(state.title, () => Option.map(Option.filter(asked.userMessage, (brought) => brought.text.length > 0), (brought) => titleOf(brought.text, config.titleChars))),
          inbox: state.inbox.map((slot) => waiting.includes(slot.id) ? { ...slot, claimedBy: Option.some(turn) } : slot),
        }
        const starting = yield* turnStartedDraft(turn, {
          runId: input.runId, key, origin, userMessage, command: asked.command,
          claimed: waiting, entry: EntryId.make(`${input.runId}:0`), at,
          // Written only when given: a turn begun without metadata is stored as before.
          ...(input.meta === undefined ? {} : { meta: input.meta }),
          ...resuming,
          ...tasked,
        }).pipe(Effect.orDie)
        const admitted: AdmittedTurn = {
          session: address, turn, runId: input.runId, key, origin, userMessage,
          command: asked.command, claimed, meta, ...resuming, ...tasked,
        }
        return { drafts: [...reap.drafts, starting], next: Option.some(next), result: { admitted, next, tookOver: reap.closed } }
      }), (opened) => Ref.set(unowned, Option.some(opened.admitted)))))
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
      yield* Option.match(begun.result.tookOver, { onNone: () => Effect.void, onSome: (taken) => closeLocal(address.id, "interrupted", Option.some(taken)) })
      // A writer that closed without storing its end (the store refused it, the scope's own try included) leaves the
      // turn open in the head under this instance: let it go, so it is not held here until the process exits.
      const letGoUnended = Ref.get(writers).pipe(Effect.flatMap((all) => Option.match(Option.fromNullishOr(all.get(address.id)), {
        onNone: () => Effect.void,
        onSome: (open) => open.turn !== turn ? Effect.void : open.ended.pipe(Effect.flatMap((ended) => ended ? Effect.void : letGo(address.id, turn))),
      })))
      // Runs after the writer's own finalizers (last added, first run): the turn counts until its end is stored.
      yield* Effect.addFinalizer(() => letGoUnended.pipe(
        Effect.andThen(Ref.update(writers, (all) => new Map([...all].filter(([id, open]) => id !== address.id || open.turn !== turn)))),
        Effect.andThen(SubscriptionRef.update(inFlight, (now): InFlight => ({ ...now, held: new Map([...now.held].filter(([key]) => key !== heldKey(address.id, turn))) })))))
      const open = yield* makeTurnWriter({
        log, config, instance, header: begun.head.header, admitted: begun.result.admitted, started,
        position: { revision: committed.revision, seq: committed.seq, state: begun.result.next, storageAt: committed.at },
        wake: wake(address.id),
      }, scope)
      yield* Ref.set(unowned, Option.none())
      yield* Ref.update(writers, (all) => new Map([...all, [address.id, { ...open, turn }]]))
      // Held from now (this process's Clock): the begin stops counting as it starts counting as open, in one update.
      const since = yield* Clock.currentTimeMillis
      yield* SubscriptionRef.update(inFlight, (now): InFlight => ({
        held: new Map([...now.held, [heldKey(address.id, turn), { session: address.id, turn, since }]]),
        beginning: now.beginning - 1,
      }))
      // Its opening commit landed before a shutdown that is now interrupting: it is closed as the others were.
      if ((yield* Ref.get(stopping)) === "interrupting") yield* closeForShutdown(address, turn)
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
  })

  const begin = Effect.fn("sessions.begin")((address: SessionAddress, input: BeginTurn) => normalized(input).pipe(
    Effect.flatMap((ready) => openTurn(address, ready)),
    Effect.map((open) => open.writer),
  ), onSession)

  /** Close this instance's writer of a session, if it holds `turn` (or any turn). */
  const closeLocal = (id: string, reason: ClosedBy, turn: Option.Option<number>) => Ref.get(writers).pipe(Effect.flatMap((all) =>
    Option.match(Option.fromNullishOr(all.get(id)), {
      onNone: () => Effect.void,
      onSome: (open) => Option.match(turn, { onNone: () => true, onSome: (wanted) => wanted === open.turn }) ? open.close(reason) : Effect.void,
    })))

  /**
   * Close the session's open turn `turn` as `ending` says, in one commit,
   * if it is still open, then this instance's writer of it: its inbox items
   * done (cancelled) or waiting again (interrupted; an attempt counted when
   * `tried`). A turn nobody holds any more is reaped instead, as by any
   * commit (interrupted, `turn.lease`): it is not open, so nothing is closed
   * and the outcome does not depend on which came first.
   */
  const closeOpen = (address: SessionAddress, turn: number, ending: { readonly reason: "cancelled" | "interrupted"; readonly failure: Option.Option<TurnFailure>; readonly tried: boolean }) => guarded(address, (head, stored) => Effect.gen(function* () {
    const reap = yield* reaped(head, stored)
    const state = reap.state
    if (Option.isSome(reap.closed)) return { drafts: reap.drafts, next: Option.some(state), result: { closed: false, pending: pendingOf(state).length } }
    if (!Option.exists(state.open, (open) => open.turn === turn)) return { drafts: [], next: Option.none<SessionsState>(), result: { closed: false, pending: pendingOf(state).length } }
    const after = closedState(state, ending.reason, config.inbox.attempts, ending.tried)
    const closing = yield* turnEndedDraft(turn, { reason: ending.reason, failure: ending.failure }).pipe(Effect.orDie)
    const dropped = yield* droppedDrafts(after.dropped, turn)
    return { drafts: [closing, ...dropped], next: Option.some(after.state), result: { closed: true, pending: pendingOf(after.state).length } }
  })).pipe(Effect.tap((done) => done.result.closed ? closeLocal(address.id, ending.reason, Option.some(turn)) : Effect.void), Effect.map((done) => done.result))

  /**
   * Close a turn this instance holds for a shutdown: stored as interrupted
   * with `turn.shutdown`, no attempt counted (the items it took were not why
   * it stopped). Its writer is closed whatever the store answers, so its
   * body stops; an end not stored is logged, and the turn is let go of, for
   * the next process to reap.
   */
  const closeForShutdown = (address: SessionAddress, turn: number) => closeOpen(address, turn, {
    reason: "interrupted",
    failure: Option.some({ code: "turn.shutdown", message: "the process shut down before the turn ended" }),
    tried: false,
  }).pipe(
    Effect.asVoid,
    Effect.tapError(() => letGo(address.id, turn).pipe(Effect.andThen(closeLocal(address.id, "interrupted", Option.some(turn))))),
    Effect.ignore({ log: "Warn", message: "a turn the shutdown closed did not store its end; this instance lets it go, for the next process to reap" }),
    Effect.annotateLogs(sessionAttributes(address.id)),
  )

  const shutdown = TurnShutdown.of({
    refuse: Ref.update(stopping, (now) => now === "running" ? "refusing" : now),
    interrupt: Effect.gen(function* () {
      yield* Ref.set(stopping, "interrupting")
      const held = [...(yield* SubscriptionRef.get(inFlight)).held.values()].sort((left, right) => left.since - right.since)
      const all = yield* Ref.get(writers)
      // The turns held now whose writer this instance still has: one whose scope is closing ended already.
      const open = held.flatMap((active) => Option.toArray(Option.filter(Option.fromNullishOr(all.get(active.session)), (writer) => writer.turn === active.turn))
        .map((writer) => ({ active, address: writer.writer.admitted.session })))
      yield* Effect.forEach(open, ({ active, address }) => closeForShutdown(address, active.turn), { concurrency: 4, discard: true })
      return open.map(({ active }) => active)
    }),
  })

  const drain = Effect.fn("sessions.drain")(function* <E, R>(address: SessionAddress, run: (writer: TurnWriter) => Effect.Effect<void, E, R>, options?: { readonly maxTurns?: number; readonly meta?: JsonObject; readonly takeOver?: boolean }): Effect.fn.Return<{ readonly turns: number }, SessionMissing | SessionContended | SessionLogError, R> {
    const maxTurns = options?.maxTurns ?? 3
    const meta = options?.meta
    const takeOver = options?.takeOver === true ? { takeOver: true } : {}
    /** One inbox turn, if one opens: then whether items still wait after it. */
    const once: Effect.Effect<Option.Option<boolean>, SessionMissing | SessionContended | SessionLogError, R> = Effect.scoped(Effect.gen(function* () {
      const runId = RunId.make(yield* Effect.sync(() => crypto.randomUUID()))
      const open = yield* openTurn(address, meta === undefined ? { _tag: "Inbox", runId, ...takeOver } : { _tag: "Inbox", runId, meta, ...takeOver })
      // A TurnError carried as a defect keeps its own tag and code, as in `Agent.turn`.
      const exit = yield* Effect.exit(harnessDefectsAsFailures(run(open.writer)))
      // The turn ends with what ended `run`: its error's code, `turn.defect` or `turn.interrupted`.
      const ending = turnEndingOf(Exit.map(exit, () => ({ outcome: "completed" as const })))
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
        Effect.map((ended) => Option.some(ended.pending > 0)),
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
      turns >= maxTurns ? Effect.succeed({ turns }) : once.pipe(Effect.flatMap(Option.match({
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

  // Each call but `changes` is a `sessions.<op>` span, with the session's id (`efferent.session.id`) on it and on its logs.
  return Context.make(TurnActivity, activity).pipe(Context.add(TurnShutdown, shutdown), Context.add(Sessions, Sessions.of({
    create: Effect.fn("sessions.create")(function* (input) {
      const id = input.id ?? (yield* freshId)
      yield* Effect.annotateCurrentSpan(sessionAttributes(id))
      // Created without a parent: a log that answers `SessionMissing` broke its contract.
      const head = yield* log.create({
        id, owner: input.owner, origin: input.origin ?? "user",
        createdAt: yield* Clock.currentTimeMillis, meta: input.meta ?? {}, parent: Option.none(),
      }).pipe(Effect.catchTag("SessionMissing", Effect.die))
      return yield* viewFrom(head)
    }),
    fork: Effect.fn("sessions.fork")(function* (parent, input) {
      // A fork of a newer release's session would carry its records into a session this release writes.
      yield* refuseNewer(yield* owned(parent))
      const endings = input.inherit ? yield* log.read(parent.id, { after: 0, limit: Option.none(), kinds: ["turn.ended"] }) : []
      const last = Option.fromNullishOr(endings.at(-1))
      const head = yield* log.create({
        id: input.id ?? (yield* freshId), owner: parent.owner, origin: input.origin,
        createdAt: yield* Clock.currentTimeMillis, meta: input.meta ?? {},
        parent: Option.some({
          id: parent.id,
          through: Option.match(last, { onNone: () => 0, onSome: (event) => event.seq }),
          turnAtFork: Option.match(last, { onNone: () => 0, onSome: (event) => Option.getOrElse(event.turn, () => 0) }),
        }),
      })
      return yield* viewFrom(head)
    }, onSession),
    get: Effect.fn("sessions.get")((address) => owned(address).pipe(Effect.flatMap(viewFrom)), onSession),
    list: Effect.fn("sessions.list")(function* (query) {
      const limit = query.limit ?? 50
      const heads = yield* log.list({
        owner: query.owner, limit, before: Option.fromNullishOr(query.before), parent: Option.fromNullishOr(query.parent),
      })
      const sessions = yield* Effect.forEach(heads, viewFrom, { concurrency: 1 })
      const last = Option.fromNullishOr(heads.at(-1))
      return {
        sessions,
        next: heads.length < limit ? Option.none() : Option.map(last, (head) => ({ updatedAt: head.updatedAt, id: head.header.id })),
      }
    }),
    remove: Effect.fn("sessions.remove")(function* (address) {
      yield* owned(address)
      yield* log.remove(address.id)
      yield* Ref.update(released, (all) => new Map([...all].filter(([session]) => session !== address.id)))
      yield* closeLocal(address.id, "removed", Option.none())
      yield* wake(address.id)
    }, onSession),
    read: Effect.fn("sessions.read")((address, query) => owned(address).pipe(Effect.flatMap(() => log.read(address.id, {
      after: query?.after ?? 0, limit: Option.fromNullishOr(query?.limit), kinds: query?.kinds ?? [],
    }))), onSession),
    changes: (address) => Stream.unwrap(RcMap.get(followers, address.id).pipe(Effect.map(Stream.fromPubSub))),
    lookup: Effect.fn("sessions.lookup")((address, key) => owned(address).pipe(Effect.flatMap(() => keyed(address.id, key)), Effect.map(Option.map((found) => found.turn))), onSession),
    transact: Effect.fn("sessions.transact")(<A, E>(address: SessionAddress, decide: (view: SessionView) => Effect.Effect<Decision<A>, E>) => guarded(address, (head, state) => Effect.gen(function* () {
      const decision = yield* decide(yield* viewOf(head, state, holder))
      const reserved = decision.drafts.find((draft) => RESERVED_KINDS.includes(draft.kind))
      if (reserved !== undefined) return yield* Effect.fail(new ReservedKind({ kind: reserved.kind }))
      return { drafts: standalone(decision.drafts), next: Option.none<SessionsState>(), result: decision.result }
    })).pipe(Effect.map((done): Decided<A> => ({ result: done.result, events: Option.match(done.committed, { onNone: () => [], onSome: (committed) => committed.events }) }))), onSession),
    // A turn nobody holds any more is reaped, as by a begin or a delivery, whichever comes first: it is not open, so the
    // cancel cancels nothing, and the outcome (interrupted, its items waiting again) does not depend on the order.
    cancel: Effect.fn("sessions.cancel")((address, turn) => closeOpen(address, turn, { reason: "cancelled", failure: Option.none(), tried: true }).pipe(
      Effect.map((done) => ({ cancelled: done.closed, pending: done.pending })),
    ), onSession),
    begin,
    deliver: Effect.fn("sessions.deliver")((address, item) => guarded(address, (head, stored) => Effect.gen(function* () {
      const reap = yield* reaped(head, stored)
      const state = reap.state
      const reapedOnly = { drafts: reap.drafts, next: reap.drafts.length === 0 ? Option.none<SessionsState>() : Option.some(state) }
      if (state.inbox.some((slot) => slot.id === item.id)) return { ...reapedOnly, result: { delivered: false, pending: pendingOf(state).length } }
      const earlier = yield* queuedIn(address.id)
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
