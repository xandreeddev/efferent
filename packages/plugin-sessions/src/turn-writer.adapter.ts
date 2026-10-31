import { Cause, Clock, Deferred, Effect, Exit, HashSet, Match, Option, Queue, Ref, Result, Schema, Scope, Semaphore, Tracer } from "effect"
import {
  canonicalJson, draftsOfEntries, entriesOfEvents, harnessError, InboxTakenData,
  isRevisionConflict, LogEntry, MEMORY_KINDS, readStored, reasonOf, replyEndingOf,
  ReservedKind, SessionContended, SessionLogError, STORED_FORMAT, turnAttributes,
  turnEndedDraft, TurnClosed, unmarkedReservedDraft, userRoleMessageOf,
} from "@xandreed/core"
import type {
  AdmittedTurn,
  Decided,
  Decision,
  RevisionConflict,
  SessionDraft,
  SessionHeader,
  SessionLog,
  SessionLogEvent,
  SessionMissing,
  QueuedInput,
  TurnDraft,
  TurnEnding,
  TurnError,
  TurnWriter,
} from "@xandreed/core"
import type { Context } from "effect"
import { closedState, droppedData, isNewerFormat, pendingOf, stateJson, stateOf, storedFormatOf, withFormat } from "./sessions-state.entity.functions.js"
import type { SessionsConfig, SessionsState } from "./sessions-state.entity.js"
import { admit, beginEnd, close, endPlanOf, endSettled, hold, latch, markTried, opened, scopeEnding, stopped, unended, withdrawEnd } from "./turn-writer.entity.functions.js"
import { EndStep, WriterPhase } from "./turn-writer.entity.js"
import type { ClosedBy, WriterStopped } from "./turn-writer.entity.js"

type Log = Context.Service.Shape<typeof SessionLog>

/** Where the writer stands: the head it last saw, and when (storage time, and this instance's clock then). */
interface Position {
  readonly revision: number
  readonly seq: number
  readonly state: SessionsState
  readonly storageAt: number
  readonly localAt: number
}

/** What a stored end answers: the inbox items it left waiting. */
interface Stored {
  readonly pending: number
}

/** The writer's phase, and the end begun last: the one an end under way shares. */
interface Phase {
  readonly phase: WriterPhase
  readonly end: Option.Option<Deferred.Deferred<Stored, TurnError>>
}

/** Where the writer stands, and the others' events it took since its begin (handed to later decisions). */
interface Cursor {
  readonly position: Position
  readonly foreign: ReadonlyArray<SessionLogEvent>
}

/** One commit's plan: the events, the state after them, and the caller's result. */
interface Plan<A> {
  readonly drafts: ReadonlyArray<TurnDraft>
  readonly next: SessionsState
  readonly result: A
  /** Only purpose-specific rejected selections skip a commit; an empty transact still commits. */
  readonly skipCommit?: boolean
}

/** The span current where the writer was asked for something (an append, a write, a commit), if any. */
type Caller = Option.Option<Tracer.AnySpan>

type Item =
  | { readonly _tag: "Append"; readonly drafts: ReadonlyArray<TurnDraft>; readonly caller: Caller }
  | { readonly _tag: "Run"; readonly run: Effect.Effect<void> }
  | { readonly _tag: "Marker"; readonly done: Deferred.Deferred<void, TurnError> }
  | { readonly _tag: "Commit"; readonly commit: Effect.Effect<void> }
  | { readonly _tag: "Tracked"; readonly item: Item; readonly settled: Effect.Effect<void> }

/** Consecutive appends as one, under the first one's caller. */
const groupsOf = (items: ReadonlyArray<Item>): ReadonlyArray<Item> => items.reduce((groups: ReadonlyArray<Item>, item): ReadonlyArray<Item> => {
  const last = groups.at(-1)
  return last?._tag === "Append" && item._tag === "Append"
    ? [...groups.slice(0, -1), { _tag: "Append", drafts: [...last.drafts, ...item.drafts], caller: last.caller }]
    : [...groups, item]
}, [])

const callerSpan: Effect.Effect<Caller> = Effect.serviceOption(Tracer.ParentSpan)

/**
 * Run the writer's work for a caller under the caller's span: the writer's
 * fiber was forked where the turn began, so its spans would otherwise sit
 * under the begin's, outside the turn's.
 */
const underCaller = (caller: Caller) => <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Option.match(caller, { onNone: () => effect, onSome: (span) => Effect.provideService(effect, Tracer.ParentSpan, span) })

export interface TurnWriterInput {
  readonly log: Log
  readonly config: SessionsConfig
  readonly instance: string
  readonly header: SessionHeader
  readonly admitted: AdmittedTurn
  readonly started: SessionLogEvent
  /** The begin commit: the head after it. */
  readonly position: { readonly revision: number; readonly seq: number; readonly state: SessionsState; readonly storageAt: number }
  /** Signal followers on this instance after each commit. */
  readonly wake: (state: SessionsState) => Effect.Effect<void>
}

/** The writer, and how the sessions service closes it from outside (a cancel or removal on this instance). */
export interface OpenWriter {
  readonly writer: TurnWriter
  readonly close: (reason: ClosedBy) => Effect.Effect<void>
  readonly ended: Effect.Effect<boolean>
  /** Count the inbox items the turn took as tried, though it wrote nothing (a drain `run` that interrupted itself). */
  readonly markTried: Effect.Effect<void>
  /** A held reply's outcome, before the closing commit; a drain preserves a partial reply. */
  readonly replyEnding: Effect.Effect<Option.Option<TurnEnding>>
}

/**
 * The open turn's writer. Items are stored strictly in queue order by one
 * fiber forked in `scope`; consecutive appends share one commit, and the
 * closing drafts the turn holds (`closing`) are stored only by the end's
 * own commit, right before its `turn.ended`. Every
 * commit expects the revision the writer last saw and, under a lease, is
 * refused by the store once the lease has run out. On a revision conflict
 * the writer reads the head again: while the turn is still its own it takes
 * the others' events (handing them to later decisions) and retries,
 * otherwise the turn was closed elsewhere and every later write fails with
 * `TurnClosed`. It fails with the tags of `TurnError`: `TurnClosed` (closed
 * elsewhere, or `ended`: its end stored or under way, or its scope closed),
 * `ReservedKind`, `SessionContended` after `retries` conflicts in a row, the
 * store's `SessionLogError`; a `HarnessError` only for its own state that
 * does not encode or decode (`session.encode`, `session.state`) and a write
 * that died (`session.defect`), with what failed as its `cause`.
 *
 * Each commit is a `turn_writer.commit` span, under the span of the call
 * that asked for it (the first append of a batch, a `transact`, an end, the
 * keep-alive); `flush` and `end` are `turn_writer.flush` and
 * `turn_writer.end`. All three carry the turn's ids (`turnAttributes`), as
 * do every span and log line of the writer's own fibers.
 */
export const makeTurnWriter = Effect.fnUntraced(function* (input: TurnWriterInput, scope: Scope.Scope): Effect.fn.Return<OpenWriter> {
  const { log, config, admitted } = input
  const id = admitted.session.id
  const ids = turnAttributes(admitted)
  const ownership = config.ownership
  const queue = yield* Queue.bounded<Item>(config.writer.capacity)
  /**
   * The writer's phase (`turn-writer.entity.ts`), moved only by its pure
   * transitions under `Ref.modify`, never a `SynchronizedRef`: the consumer
   * fiber latches failures while an admitter holds the admission permit,
   * blocked on a full queue, so a lock on the phase would deadlock them.
   */
  const phase = yield* Ref.make<Phase>({ phase: opened, end: Option.none() })
  const phaseNow = Ref.get(phase).pipe(Effect.map((current) => current.phase))
  /** Orders admissions (a check of the phase, then the offer); it never guards the phase. */
  const admission = yield* Semaphore.make(1)
  /** Every queued caller's refusal, until its item settles: what a close fails. */
  const waiting = yield* Ref.make(HashSet.empty<(error: TurnError) => Effect.Effect<void>>())
  const closed = yield* Deferred.make<TurnClosed>()
  const cursor = yield* Ref.make<Cursor>({ position: { ...input.position, localAt: yield* Clock.currentTimeMillis }, foreign: [] })

  const closedAs = (reason: TurnClosed["reason"]) => new TurnClosed({ session: id, turn: admitted.turn, reason })
  /** Its end stored or under way, or its scope closed: the writer's own `TurnClosed`. */
  const sealed = closedAs("ended")
  /** What a stopped phase refuses with, as its callers see it: its failure, or its `TurnClosed`. */
  const refusal = (stop: WriterStopped): TurnError => stop._tag === "Failed" ? stop.error : closedAs(stop.reason)
  /** Apply a transition that may refuse: the phase moves only when it is admitted, and a refusal fails with its `TurnError`. */
  const transition = <A>(decide: (current: Phase) => Result.Result<readonly [A, Phase], WriterStopped>): Effect.Effect<A, TurnError> =>
    Ref.modify(phase, (current) => Result.match(decide(current), {
      onFailure: (stop): readonly [Result.Result<A, TurnError>, Phase] => [Result.fail(refusal(stop)), current],
      onSuccess: ([result, next]): readonly [Result.Result<A, TurnError>, Phase] => [Result.succeed(result), next],
    })).pipe(Effect.flatMap((decided) => Effect.fromResult(decided)))
  /** A write failed or found the turn closed: the writer stops with it (the first stop wins). */
  const stopWith = (error: TurnError) => Ref.update(phase, (current) => ({ ...current, phase: latch(current.phase, error) }))
  const refuseWaiting = (error: TurnError) => Ref.get(waiting).pipe(Effect.flatMap((all) => Effect.forEach(all, (refuse) => refuse(error), { concurrency: 1, discard: true })))
  /**
   * Close the turn as someone else closed it: every later write, and every
   * caller waiting, fails with that `TurnClosed`. Nothing once its end is
   * stored.
   */
  const closeBy = (reason: ClosedBy): Effect.Effect<void> => Ref.modify(phase, (current) => Result.match(close(current.phase, reason), {
    onFailure: () => [false, current] as const,
    onSuccess: (next) => [true, { ...current, phase: next }] as const,
  })).pipe(Effect.flatMap((closing) => closing
    ? Deferred.succeed(closed, closedAs(reason)).pipe(Effect.andThen(refuseWaiting(closedAs(reason))))
    : Effect.void))
  /** Close the turn, then fail with how it was closed. */
  const closeAndFail = (reason: ClosedBy) => closeBy(reason).pipe(Effect.andThen(Effect.fail(closedAs(reason))))
  /** A read that found the session gone: it was removed. */
  const removed = () => closeAndFail("removed")
  /** Fail with the writer's stop, once it failed or was closed. */
  const refuseIfStopped = phaseNow.pipe(Effect.flatMap((now) => Option.match(stopped(now), { onNone: () => Effect.void, onSome: (stop) => Effect.fail(refusal(stop)) })))
  /** Admit a write unless the writer stopped, is ending or ended; one the turn `tries` with (it writes something) marks the turn as having tried. */
  const admitWrite = (tries: boolean) => transition((current) => Result.map(admit(current.phase, tries), (next) => [undefined, { ...current, phase: next }] as const))
  /** A draft under one of the framework's kinds is refused unless the framework's turn wrote it. */
  const refuseIfReserved = (drafts: ReadonlyArray<TurnDraft>) => Option.match(unmarkedReservedDraft(drafts), {
    onNone: () => Effect.void,
    onSome: (draft) => Effect.fail(new ReservedKind({ kind: draft.kind })),
  })

  /** The storage clock now, from the last reading plus this instance's elapsed time. */
  const storageNow = Effect.gen(function* () {
    const at = (yield* Ref.get(cursor)).position
    return at.storageAt + ((yield* Clock.currentTimeMillis) - at.localAt)
  })

  /** The state with the open turn's lease extended, when the ownership renews on writes. */
  const renewed = (state: SessionsState, now: number, always: boolean): SessionsState =>
    ownership.mode === "lease" && (always || ownership.renew !== "none")
      ? { ...state, open: Option.map(state.open, (open) => ({ ...open, expiresAt: Option.some(now + ownership.ttlMs) })) }
      : state

  const stamped = (drafts: ReadonlyArray<TurnDraft>): ReadonlyArray<SessionDraft> =>
    drafts.map((draft) => ({ kind: draft.kind, turn: Option.some(admitted.turn), data: draft.data }))

  /** Why a turn someone else closed was closed: its `turn.ended`, if the others wrote one (an end that does not decode tells nothing). */
  const reasonIn = (events: ReadonlyArray<SessionLogEvent>): Effect.Effect<ClosedBy> =>
    readStored("turn.ended", events.filter((event) => Option.contains(event.turn, admitted.turn))).pipe(
      Effect.map((ends): ClosedBy => ends.some((ended) => ended.data.reason === "cancelled") ? "cancelled" : "interrupted"),
      Effect.catchTag("SchemaError", () => Effect.succeed<ClosedBy>("interrupted")),
    )

  /**
   * After a conflict: take the others' events and go on while the turn is
   * ours, or close and fail with `TurnClosed`. A turn taken from us closes
   * even when the others' events cannot be read (as interrupted, its reason
   * unknown).
   */
  const rebase = (seen: Position): Effect.Effect<void, TurnError> => Effect.gen(function* () {
    const head = yield* log.head(id).pipe(Effect.catchTag("SessionMissing", removed))
    const format = yield* storedFormatOf(head).pipe(Effect.mapError((error) => new SessionLogError({ code: "session.state", message: error.message, cause: error })))
    if (isNewerFormat(format)) return yield* Effect.fail(new SessionLogError({ code: "session.version", message: `the session holds stored format ${format}, written by a newer release; this release reads up to ${STORED_FORMAT}` }))
    const state = yield* stateOf(head).pipe(Effect.mapError((error) => harnessError("session.state", error.message, error)))
    const since = log.read(id, { after: seen.seq, limit: Option.none(), kinds: [] }).pipe(
      Effect.catchTag("SessionMissing", removed),
      Effect.map((events) => events.filter((event) => event.seq <= head.seq)),
    )
    const ours = Option.exists(state.open, (open) => open.turn === admitted.turn && open.holder === input.instance && open.runId === admitted.runId)
    if (!ours) return yield* closeAndFail(yield* reasonIn(yield* since.pipe(Effect.catchTag("SessionLogError", () => Effect.succeed([])))))
    const events = yield* since
    const localAt = yield* Clock.currentTimeMillis
    yield* Ref.update(cursor, (current) => ({
      position: { revision: head.revision, seq: head.seq, state, storageAt: head.now, localAt },
      foreign: [...current.foreign, ...events],
    }))
  })

  /**
   * One guarded commit of what `plan` decides from the current position and
   * the others' events; decided again at once after each conflict,
   * `config.retries` attempts in all before `SessionContended`. Every
   * conflict rebases first, the last one included, so a turn taken
   * meanwhile fails with `TurnClosed`.
   */
  const commitPlan = <A, E>(plan: (at: Position, others: ReadonlyArray<SessionLogEvent>) => Effect.Effect<Plan<A>, E>, options: { readonly renew: boolean; readonly tried?: boolean }): Effect.Effect<Decided<A>, E | TurnError> => {
    const once: Effect.Effect<Decided<A>, E | TurnError | RevisionConflict> = Effect.gen(function* () {
      yield* refuseIfStopped
      const { position: at, foreign } = yield* Ref.get(cursor)
      const decided = yield* plan(at, foreign)
      if (decided.skipCommit === true) return { result: decided.result, events: [] }
      const now = yield* storageNow
      // In this release's stored format: raised once when another instance, of an earlier release, wrote the state since.
      const next = withFormat(options.renew ? renewed(decided.next, now, false) : decided.next)
      const notAfter = ownership.mode === "lease" ? Option.flatMap(at.state.open, (open) => open.expiresAt) : Option.none()
      const state = next === at.state ? Option.none() : Option.some(yield* stateJson(next).pipe(Effect.mapError((error) => harnessError("session.encode", error.message, error))))
      const store = Effect.gen(function* () {
        const committed = yield* log.commit(id, { expect: at.revision, notAfter, events: stamped(decided.drafts), state })
        const localAt = yield* Clock.currentTimeMillis
        yield* Ref.update(cursor, (current) => ({ ...current, position: { revision: committed.revision, seq: committed.seq, state: next, storageAt: committed.at, localAt } }))
        if (options.tried === true) yield* Ref.update(phase, (current) => ({ ...current, phase: markTried(current.phase) }))
        yield* input.wake(next)
        return { result: decided.result, events: committed.events }
      })
      // A successful take cannot lose its attempt mark between the durable ACK and bookkeeping.
      return yield* (options.tried === true ? Effect.uninterruptible(store) : store).pipe(Effect.catchTags({
        RevisionConflict: (conflict) => rebase(at).pipe(Effect.andThen(Effect.fail(conflict))),
        LeaseExpired: () => closeAndFail("interrupted"),
        SessionMissing: () => closeAndFail("removed"),
      }))
    })
    return once.pipe(
      Effect.retry({ times: config.retries - 1, while: isRevisionConflict }),
      Effect.catchIf(isRevisionConflict, () => Effect.fail(new SessionContended({ session: id, attempts: config.retries }))),
      Effect.withSpan("turn_writer.commit", { attributes: ids }),
    )
  }

  /** A failed store write latches: the turn fails at its next touch of the writer. */
  const latching = <A>(effect: Effect.Effect<A, TurnError>): Effect.Effect<Option.Option<A>> => effect.pipe(
    Effect.map(Option.some),
    Effect.catch((error) => stopWith(error).pipe(Effect.as(Option.none()))),
  )

  const unchanged = <A>(result: A, drafts: ReadonlyArray<TurnDraft>) => (at: Position) => Effect.succeed<Plan<A>>({ drafts, next: at.state, result })

  /** One queued item, in order: a stopped writer settles a marker with its refusal and drops an append; a run or a commit runs as it is. */
  const process = (item: Item): Effect.Effect<void> => {
    const failure = phaseNow.pipe(Effect.map((now) => Option.map(stopped(now), refusal)))
    return Match.valueTags(item, {
      Tracked: (tracked) => process(tracked.item).pipe(Effect.ensuring(tracked.settled)),
      Marker: (marker) => failure.pipe(Effect.flatMap(Option.match({ onNone: () => Deferred.succeed(marker.done, undefined), onSome: (error) => Deferred.fail(marker.done, error) })), Effect.asVoid),
      Run: (run) => run.run,
      Commit: (commit) => commit.commit,
      Append: (append) => failure.pipe(Effect.flatMap((stop) => Option.isSome(stop) ? Effect.void
        : latching(commitPlan(unchanged(undefined, append.drafts), { renew: true })).pipe(Effect.asVoid, underCaller(append.caller)))),
    })
  }

  /**
   * An item that dies with a defect (a store or an encoder that throws) latches
   * as `session.defect`, the defect its `cause`, and is logged with its cause;
   * the consumer goes on, so every later item, and every caller waiting on
   * one, is refused with it.
   */
  const died = (defect: unknown) => Effect.gen(function* () {
    const reason = reasonOf(Cause.die(defect))
    yield* stopWith(harnessError("session.defect", `a write of turn ${admitted.turn} died: ${reason}`, defect))
    yield* Effect.logError("the turn's writer stopped storing: a write died with a defect", Cause.die(defect))
  })

  // The writer's own fibers carry the turn's ids on their spans (the log's under each commit) and logs.
  const asTheTurn = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.annotateSpans(ids), Effect.annotateLogs(ids))

  yield* Effect.forkIn(Queue.takeBetween(queue, 1, config.writer.batch).pipe(
    Effect.flatMap((chunk) => Effect.forEach(groupsOf(chunk), (item) => process(item).pipe(Effect.catchDefect(died)), { concurrency: 1, discard: true })),
    Effect.forever,
    asTheTurn,
  ), scope)

  const offer = (item: Item): Effect.Effect<void, TurnError> => Queue.offer(queue, item).pipe(
    // The queue is shut down once the scope closed.
    Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(sealed)),
  )

  /**
   * Keep every result reachable until it settles, including an item already
   * taken by the consumer. A caller interrupted before its item is queued is
   * only forgotten: nobody else awaits its result.
   */
  const enqueue = <A, E>(result: Deferred.Deferred<A, E | TurnError>, item: Item): Effect.Effect<void, TurnError> => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const refuse = (error: TurnError) => Deferred.fail(result, error).pipe(Effect.asVoid)
    const settled = Ref.update(waiting, HashSet.remove(refuse))
    yield* Ref.update(waiting, HashSet.add(refuse))
    yield* restore(offer({ _tag: "Tracked", item, settled })).pipe(
      Effect.onInterrupt(() => settled),
      Effect.tapError((error) => refuse(error).pipe(Effect.andThen(settled))),
    )
  }))

  /** Admit an item unless the writer stopped, is ending or ended; one the turn `tries` with (a write, a transact) marks the turn as having tried. */
  const admitItem = <A, E>(result: Deferred.Deferred<A, E | TurnError>, item: Item, tries: boolean) => admission.withPermits(1)(
    admitWrite(tries).pipe(Effect.andThen(enqueue(result, item))),
  )

  /** Queue `commit` and wait for its result, in queue order. */
  const inOrder = <A, E>(commit: Effect.Effect<A, E | TurnError>, tries: boolean): Effect.Effect<A, E | TurnError> => Effect.gen(function* () {
    const result = yield* Deferred.make<A, E | TurnError>()
    const caller = yield* callerSpan
    yield* admitItem(result, { _tag: "Commit", commit: Effect.exit(commit).pipe(Effect.flatMap((exit) => Deferred.done(result, exit)), Effect.asVoid, underCaller(caller)) }, tries)
    return yield* Deferred.await(result)
  })

  const flush: Effect.Effect<void, TurnError> = Deferred.make<void, TurnError>().pipe(Effect.flatMap((done) =>
    admission.withPermits(1)(refuseIfStopped.pipe(Effect.andThen(enqueue(done, { _tag: "Marker", done })))).pipe(Effect.andThen(Deferred.await(done)))))

  /**
   * The end's commit: the turn's close, planned while the writer is open or
   * ending, from whether the turn tried the items it took. One commit stores
   * the closing drafts held, then `turn.ended`, then the items it dropped.
   */
  const endNow = (ending: TurnEnding): Effect.Effect<Stored, TurnError> => commitPlan((at) => Effect.gen(function* () {
    const plan = yield* phaseNow.pipe(Effect.flatMap((now) => Result.match(endPlanOf(now), { onFailure: (stop) => Effect.fail(refusal(stop)), onSuccess: Effect.succeed })))
    const after = closedState(at.state, ending.reason, config.inbox.attempts, plan.tried)
    const ended = yield* turnEndedDraft(admitted.turn, ending).pipe(Effect.mapError((error) => harnessError("session.encode", error.message, error)))
    const dropped = yield* Effect.forEach(after.dropped, (item) => droppedData(item).pipe(
      Effect.map((data): TurnDraft => ({ kind: "inbox.dropped", data })),
      Effect.mapError((error) => harnessError("session.encode", error.message, error)),
    ), { concurrency: 1 })
    return { drafts: [...plan.closing, { kind: ended.kind, data: ended.data }, ...dropped], next: after.state, result: { pending: pendingOf(after.state).length } }
  }), { renew: false }).pipe(Effect.map((done) => done.result))

  /** Whether `done` is the end begun last: only its own settling, or its withdrawal, moves the phase. */
  const isLast = (current: Phase, done: Deferred.Deferred<Stored, TurnError>) => Option.exists(current.end, (last) => last === done)

  /**
   * Settle an end's shared result. The phase moves first (`endSettled`): an
   * end refused but as closed reopens admission before its callers hear of
   * it, so a later end (the scope's own, at the latest) tries again, and a
   * refusal never unseals another end begun meanwhile.
   */
  const settleEnd = (done: Deferred.Deferred<Stored, TurnError>, exit: Exit.Exit<Stored, TurnError>) =>
    Ref.update(phase, (current) => isLast(current, done) ? { ...current, phase: endSettled(current.phase, exit) } : current).pipe(
      Effect.andThen(Deferred.done(done, exit)), Effect.asVoid)

  /** An end withdrawn before it was queued (its caller interrupted while it waited for room) reopens admission. */
  const withdraw = (done: Deferred.Deferred<Stored, TurnError>) =>
    Ref.update(phase, (current) => isLast(current, done) ? { ...current, phase: withdrawEnd(current.phase) } : current)

  /** The first end seals admission before it is offered; every end while it runs awaits that same commit, and one after it is stored has its answer. */
  const end = Effect.fn("turn_writer.end", { attributes: ids })(function* (value: TurnEnding): Effect.fn.Return<Stored, TurnError> {
    const caller = yield* callerSpan
    const result = yield* admission.withPermits(1)(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const done = yield* Deferred.make<Stored, TurnError>()
      const [step, last] = yield* transition((current) => Result.map(beginEnd(current.phase, value), (step) =>
        [[step, current.end] as const, EndStep.guards.Start(step) ? { phase: step.phase, end: Option.some(done) } : current] as const))
      return yield* EndStep.match(step, {
        Start: () => restore(enqueue(done, { _tag: "Commit", commit: Effect.exit(endNow(value)).pipe(Effect.flatMap((exit) => settleEnd(done, exit)), underCaller(caller)) })).pipe(
          Effect.onInterrupt(() => withdraw(done)),
          Effect.as(Deferred.await(done)),
        ),
        // Ending: the end under way is the one begun last.
        Share: () => Option.match(last, { onNone: () => Effect.die(new Error("the turn's end under way has no result to share")), onSome: (under) => Effect.succeed(Deferred.await(under)) }),
        Stored: (stored) => Effect.succeed(Effect.succeed<Stored>({ pending: stored.pending })),
      })
    })))
    return yield* result
  })

  // The keep-alive extends the lease between writes: every `everyMs`, a state-only commit (it bumps the
  // head's `updatedAt`), the first one interval after the begin, whose own commit set the lease, so a short
  // turn costs no extra commit. It is queued in order with the turn's items, so a `write` or `transact`
  // still running holds it back. When it is refused, the turn was closed elsewhere.
  if (ownership.mode === "lease" && typeof ownership.renew === "object") {
    const every = `${ownership.renew.everyMs} millis` as const
    const renew = inOrder(commitPlan((at) => Effect.gen(function* () {
      return { drafts: [], next: renewed(at.state, yield* storageNow, true), result: undefined }
    }), { renew: false }), false).pipe(
      // Refused as closed (the turn ended, or was closed elsewhere), there is nothing left to renew; anything else is logged.
      Effect.catchTag("TurnClosed", (refused) => Effect.logDebug(`the turn's keep-alive did not renew its lease: the turn was ${refused.reason}`)),
      Effect.catch((error) => Effect.logWarning(`the turn's keep-alive did not renew its lease: ${reasonOf(Cause.fail(error))}`)),
    )
    yield* Effect.forkIn(Effect.sleep(every).pipe(Effect.andThen(renew), Effect.forever, Effect.asVoid, asTheTurn), scope)
  }

  // Runs first when the scope closes (finalizers run last-added first), storing the closing drafts held.
  // A turn whose end could not be stored is ended again with that same ending; a turn never ended ends
  // as its held reply implies (completed or partial), else as interrupted (`turn.interrupted`) when its
  // scope was interrupted, as failed (`turn.unended`) otherwise (`scopeEnding`); a writer that stopped
  // has no ending of its own, and its end is refused as any other. An end still not stored within 10 s
  // is logged (the writer has not ended: the sessions service lets the turn go).
  yield* Scope.addFinalizerExit(scope, (exit) => phaseNow.pipe(Effect.flatMap((now) => WriterPhase.guards.Ended(now) ? Effect.void
    : end(Option.getOrElse(scopeEnding(now, exit), () => unended(exit))).pipe(
      Effect.timeoutOption("10 seconds"),
      Effect.flatMap(Option.match({
        onSome: () => Effect.void,
        onNone: () => Effect.logWarning("the turn's end was not stored within 10 seconds of its scope closing"),
      })),
      // Refused as closed, the turn was closed elsewhere: nothing was left to store.
      Effect.catchTag("TurnClosed", (refused) => Effect.logDebug(`the turn's end was not stored when its scope closed: the turn was ${refused.reason}`)),
      Effect.catch((error) => Effect.logWarning(`the turn's end was not stored when its scope closed: ${reasonOf(Cause.fail(error))}`)),
      Effect.annotateLogs(ids),
    )), Effect.ensuring(Effect.gen(function* () {
      yield* stopWith(sealed)
      yield* Queue.shutdown(queue)
      yield* refuseWaiting(sealed)
    }))))

  /** Read the immutable queued messages at exactly the refreshed head used by this operation. */
  const waitingSteers = (at: Position): Effect.Effect<ReadonlyArray<QueuedInput>, TurnError> => Effect.gen(function* () {
    const slots = pendingOf(at.state).filter((slot) => slot.delivery === "steer")
    if (slots.length === 0) return []
    const events = yield* log.read(id, { after: 0, limit: Option.none(), kinds: ["inbox.queued"] }).pipe(Effect.catchTag("SessionMissing", removed))
    const queued = yield* readStored("inbox.queued", events.filter((event) => event.seq <= at.seq)).pipe(
      Effect.mapError((error) => new SessionLogError({ code: "session.decode", message: error.message, cause: error })),
    )
    return yield* Effect.forEach(slots, (slot) => {
      const stored = queued.find(({ data }) => data.id === slot.id && data.input?.delivery === "steer")
      return stored?.data.input === undefined
        ? Effect.fail(new SessionLogError({ code: "session.decode", message: "a pending steer has no immutable queued input" }))
        : Effect.succeed({ id: slot.id, source: stored.data.source, ...stored.data.input })
    }, { concurrency: 1 })
  })

  const refreshed = Ref.get(cursor).pipe(Effect.flatMap(({ position }) => rebase(position)), Effect.andThen(Ref.get(cursor)), Effect.map(({ position }) => position))
  const invalidTake = (message: string) => harnessError("memory.log", message)

  const take = (entries: ReadonlyArray<LogEntry>): Effect.Effect<boolean, TurnError> => inOrder(Effect.gen(function* () {
    // Do not decide false from the cached cursor after another instance has enqueued a steer.
    yield* refreshed
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(LogEntry))(entries).pipe(
      Effect.mapError((error) => harnessError("memory.log", "the steering entries do not decode", error)),
    )
    const selected = yield* Effect.forEach(decoded, (entry) => Effect.gen(function* () {
      if (entry.body._tag !== "Message" || entry.body.message.role !== "user" || entry.body.inbox === undefined || entry.body.run === undefined
        || entry.runId !== admitted.runId || entry.turn !== admitted.turn) {
        return yield* Effect.fail(invalidTake("steering entries must be inbox user messages with a run ordinal for this turn"))
      }
      const index = Number(entry.id.slice(`${admitted.runId}:`.length))
      if (!Number.isSafeInteger(index) || index < 1 || entry.id !== `${admitted.runId}:${index}`) {
        return yield* Effect.fail(invalidTake("a steering entry id must belong to this run and name a positive index"))
      }
      return { entry, id: entry.body.inbox, message: entry.body.message }
    }), { concurrency: 1 })
    if (new Set(selected.map(({ id }) => id)).size !== selected.length || new Set(selected.map(({ entry }) => entry.id)).size !== selected.length) {
      return yield* Effect.fail(invalidTake("steering entries must have distinct input and entry ids"))
    }
    const result = yield* commitPlan((at) => Effect.gen(function* () {
      const ids = new Set(selected.map(({ id }) => id))
      const eligible = pendingOf(at.state).filter((slot) => ids.has(slot.id) && slot.delivery === "steer")
      if (selected.length === 0 || eligible.length !== selected.length) return { drafts: [], next: at.state, result: false, skipCommit: true }
      const queued = yield* waitingSteers(at)
      if (selected.some(({ id, message }) => !queued.some((input) => input.id === id && canonicalJson(message) === canonicalJson(userRoleMessageOf(input.userMessage))))) {
        return yield* Effect.fail(invalidTake("a steering message must exactly match its immutable queued input"))
      }
      const previous = yield* log.read(id, { after: Math.max(0, input.started.seq - 1), limit: Option.none(), kinds: MEMORY_KINDS }).pipe(Effect.catchTag("SessionMissing", removed))
      const stored = yield* entriesOfEvents(previous.filter((event) => event.seq <= at.seq)).pipe(
        Effect.mapError((error) => new SessionLogError({ code: "session.decode", message: error.message, cause: error })),
      )
      if (selected.some(({ entry }) => stored.some((earlier) => earlier.id === entry.id))) return yield* Effect.fail(invalidTake("a steering entry id was already recorded"))
      const drafts = yield* draftsOfEntries(decoded).pipe(Effect.mapError((error) => harnessError("memory.log", "the steering entries do not encode", error)))
      const receipts = yield* Effect.forEach(selected, ({ id, entry }) => Schema.encodeEffect(InboxTakenData)({ id, entry: entry.id }).pipe(
        Effect.map((data): TurnDraft => ({ kind: "inbox.taken", data: { ...data } })),
        Effect.mapError((error) => harnessError("memory.log", "the steering receipt does not encode", error)),
      ), { concurrency: 1 })
      return { drafts: [...drafts.map((draft): TurnDraft => ({ kind: draft.kind, data: draft.data })), ...receipts], next: { ...at.state, inbox: at.state.inbox.filter((slot) => !ids.has(slot.id)) }, result: true }
    }), { renew: true, tried: true })
    return result.result
  }), false)

  const writer: TurnWriter = {
    admitted,
    started: input.started,
    history: (kinds) => historyOf(log, input.header, input.started, kinds).pipe(Effect.catchTag("SessionMissing", removed)),
    snapshot: (kinds, after) => flush.pipe(Effect.andThen(after === undefined
      ? historyOf(log, input.header, input.started, kinds, true)
      : log.read(id, { after, limit: Option.none(), kinds })), Effect.catchTag("SessionMissing", removed)),
    steers: inOrder(refreshed.pipe(Effect.flatMap(waitingSteers)), false),
    take,
    append: (drafts) => refuseIfReserved(drafts).pipe(Effect.andThen(admission.withPermits(1)(
      admitWrite(drafts.length > 0).pipe(Effect.andThen(drafts.length === 0 ? Effect.void : callerSpan.pipe(Effect.flatMap((caller) => offer({ _tag: "Append", drafts, caller })))))))),
    write: Effect.fnUntraced(function* <A, E>(op: Effect.Effect<A, E>): Effect.fn.Return<A, E | TurnError> {
      const result = yield* Deferred.make<A, E | TurnError>()
      const caller = yield* callerSpan
      const run = Effect.exit(Effect.raceFirst(
        refuseIfStopped.pipe(Effect.andThen(op)),
        Deferred.await(closed).pipe(Effect.flatMap((note) => Effect.fail(note))),
      )).pipe(Effect.flatMap((exit) => Deferred.done(result, exit)), Effect.asVoid, underCaller(caller))
      yield* admitItem(result, { _tag: "Run", run }, true)
      return yield* Deferred.await(result)
    }),
    transact: <A, E>(decide: (others: ReadonlyArray<SessionLogEvent>) => Effect.Effect<Decision<A>, E>) =>
      inOrder(commitPlan((at, others) => decide(others).pipe(
        Effect.tap((decision) => refuseIfReserved(decision.drafts)),
        Effect.map((decision): Plan<A> => ({ drafts: decision.drafts, next: at.state, result: decision.result })),
      ), { renew: true }), true),
    flush: flush.pipe(Effect.withSpan("turn_writer.flush", { attributes: ids })),
    closing: (drafts) => refuseIfReserved(drafts).pipe(Effect.andThen(transition((current) =>
      Result.map(hold(current.phase, drafts), (next) => [undefined, { ...current, phase: next }] as const)))),
    end,
    closed: Deferred.await(closed),
  }
  return {
    writer,
    close: closeBy,
    ended: phaseNow.pipe(Effect.map(WriterPhase.guards.Ended)),
    markTried: Ref.update(phase, (current) => ({ ...current, phase: markTried(current.phase) })),
    replyEnding: phaseNow.pipe(Effect.map((current) => WriterPhase.match(current, {
      Open: (open) => replyEndingOf(open.closing), Ending: (ending) => Option.some(ending.ending),
      Failed: () => Option.none(), Closed: () => Option.none(), Ended: () => Option.none(),
    }))),
  }
})

/**
 * A session's events before `started`, its fork's parent (up to the fork
 * point) first. `SessionMissing` when the session, or a parent it inherits
 * from, is gone: removing a session removes its children.
 */
const historyOf = (log: Log, header: SessionHeader, started: SessionLogEvent, kinds: ReadonlyArray<string>, includeCurrent = false): Effect.Effect<ReadonlyArray<SessionLogEvent>, SessionMissing | SessionLogError> => {
  const ancestors = (lineage: SessionHeader["parent"]): Effect.Effect<ReadonlyArray<SessionLogEvent>, SessionMissing | SessionLogError> => Option.match(lineage, {
    onNone: () => Effect.succeed([]),
    onSome: (parent) => parent.through <= 0 ? Effect.succeed([]) : Effect.gen(function* () {
      const head = yield* log.head(parent.id)
      const earlier = yield* ancestors(head.header.parent)
      const events = yield* log.read(parent.id, { after: 0, limit: Option.none(), kinds })
      return [...earlier, ...events.filter((event) => event.seq <= parent.through)]
    }),
  })
  return Effect.gen(function* () {
    const inherited = yield* ancestors(header.parent)
    const own = yield* log.read(header.id, { after: 0, limit: Option.none(), kinds })
    return [...inherited, ...own.filter((event) => includeCurrent || event.seq < started.seq)]
  })
}
