import { Clock, Deferred, Effect, Exit, Option, Queue, Ref, Schedule, Scope, Semaphore } from "effect"
import { HarnessError, turnEndedDraft, TurnClosed } from "@xandreed/core"
import type {
  AdmittedTurn,
  Decided,
  Decision,
  SessionDraft,
  SessionHeader,
  SessionLog,
  SessionLogEvent,
  TurnDraft,
  TurnEnding,
  TurnWriter,
} from "@xandreed/core"
import type { Context } from "effect"
import { closedState, pendingOf, stateJson, stateOf } from "./sessions-state.entity.functions.js"
import type { SessionsConfig, SessionsState } from "./sessions-state.entity.js"

type Log = Context.Service.Shape<typeof SessionLog>

const harness = (code: string, message: string) => new HarnessError({ code, message })

/** Where the writer stands: the head it last saw, and when (storage time, and this instance's clock then). */
interface Position {
  readonly revision: number
  readonly seq: number
  readonly state: SessionsState
  readonly storageAt: number
  readonly localAt: number
}

/** One commit's plan: the events, the state after them, and the caller's result. */
interface Plan<A> {
  readonly drafts: ReadonlyArray<TurnDraft>
  readonly next: SessionsState
  readonly result: A
}

type Item =
  | { readonly _tag: "Append"; readonly drafts: ReadonlyArray<TurnDraft> }
  | { readonly _tag: "Run"; readonly run: Effect.Effect<void> }
  | { readonly _tag: "Marker"; readonly done: Deferred.Deferred<void, HarnessError> }
  | { readonly _tag: "Commit"; readonly commit: Effect.Effect<void> }
  | { readonly _tag: "Tracked"; readonly item: Item; readonly settled: Effect.Effect<void> }

const groupsOf = (items: ReadonlyArray<Item>): ReadonlyArray<Item> => items.reduce((groups: ReadonlyArray<Item>, item): ReadonlyArray<Item> => {
  const last = groups.at(-1)
  return last?._tag === "Append" && item._tag === "Append"
    ? [...groups.slice(0, -1), { _tag: "Append", drafts: [...last.drafts, ...item.drafts] }]
    : [...groups, item]
}, [])

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
  readonly wake: Effect.Effect<void>
}

/** The writer, and how the sessions service closes it from outside (a cancel or removal on this instance). */
export interface OpenWriter {
  readonly writer: TurnWriter
  readonly close: (reason: TurnClosed["reason"]) => Effect.Effect<void>
  readonly ended: Effect.Effect<boolean>
}

/**
 * The open turn's writer. Items are stored strictly in queue order by one
 * fiber forked in `scope`; consecutive appends share one commit. Every
 * commit expects the revision the writer last saw and, under a lease, is
 * refused by the store once the lease has run out. On a revision conflict
 * the writer reads the head again: while the turn is still its own it takes
 * the others' events (handing them to later decisions) and retries,
 * otherwise the turn was closed elsewhere and every later write fails with
 * `turn.closed`.
 */
export const makeTurnWriter = (input: TurnWriterInput, scope: Scope.Scope): Effect.Effect<OpenWriter> => Effect.gen(function* () {
  const { log, config, admitted } = input
  const id = admitted.session.id
  const ownership = config.ownership
  const queue = yield* Queue.bounded<Item>(config.writer.capacity)
  const failed = yield* Ref.make(Option.none<HarnessError>())
  const ended = yield* Ref.make(false)
  const sealed = yield* Ref.make(false)
  const admission = yield* Semaphore.make(1)
  const ending = yield* Ref.make(Option.none<Deferred.Deferred<{ readonly pending: number }, HarnessError>>())
  const waiting = yield* Ref.make<ReadonlySet<(error: HarnessError) => Effect.Effect<void>>>(new Set())
  const closed = yield* Deferred.make<TurnClosed>()
  const foreign = yield* Ref.make<ReadonlyArray<SessionLogEvent>>([])
  const position = yield* Ref.make<Position>({ ...input.position, localAt: yield* Clock.currentTimeMillis })

  const close = (reason: TurnClosed["reason"]): Effect.Effect<void> => Effect.gen(function* () {
    if (yield* Ref.get(ended)) return
    const error = harness("turn.closed", `turn ${admitted.turn} was ${reason}`)
    yield* Ref.update(failed, Option.orElse(() => Option.some(error)))
    yield* Deferred.succeed(closed, new TurnClosed({ session: id, turn: admitted.turn, reason }))
    yield* Effect.forEach(yield* Ref.get(waiting), (refuse) => refuse(error), { discard: true })
  })
  const refuseIfFailed = Ref.get(failed).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Effect.fail })))
  const refuseIfEnded = Ref.get(ended).pipe(Effect.flatMap((done) => done ? Effect.fail(harness("turn.closed", `turn ${admitted.turn} has ended`)) : Effect.void))
  const refuseIfSealed = Ref.get(sealed).pipe(Effect.flatMap((done) => done ? Effect.fail(harness("turn.closed", `turn ${admitted.turn} is ending`)) : Effect.void))

  /** The storage clock now, from the last reading plus this instance's elapsed time. */
  const storageNow = Effect.gen(function* () {
    const at = yield* Ref.get(position)
    return at.storageAt + ((yield* Clock.currentTimeMillis) - at.localAt)
  })

  /** The state with the open turn's lease extended, when the ownership renews on writes. */
  const renewed = (state: SessionsState, now: number, always: boolean): SessionsState =>
    ownership.mode === "lease" && (always || ownership.renew !== "none")
      ? { ...state, open: Option.map(state.open, (open) => ({ ...open, expiresAt: Option.some(now + ownership.ttlMs) })) }
      : state

  const stamped = (drafts: ReadonlyArray<TurnDraft>): ReadonlyArray<SessionDraft> =>
    drafts.map((draft) => ({ kind: draft.kind, turn: Option.some(admitted.turn), data: draft.data }))

  /** Why a turn someone else closed was closed: its `turn.ended`, if the others wrote one. */
  const reasonIn = (events: ReadonlyArray<SessionLogEvent>): TurnClosed["reason"] =>
    events.some((event) => event.kind === "turn.ended" && Option.contains(event.turn, admitted.turn) && event.data.reason === "cancelled") ? "cancelled" : "interrupted"

  /**
   * After a conflict: take the others' events and go on while the turn is
   * ours, or close. A turn taken from us closes even when the others' events
   * cannot be read (as interrupted, its reason unknown).
   */
  const rebase = (seen: Position): Effect.Effect<boolean, HarnessError> => Effect.gen(function* () {
    const removed = () => close("removed").pipe(Effect.andThen(Effect.fail(harness("turn.closed", "the session was removed"))))
    const head = yield* log.head(id).pipe(Effect.catchTag("SessionMissing", removed))
    const state = yield* stateOf(head).pipe(Effect.mapError((error) => harness("session.state", error.message)))
    const since = log.read(id, { after: seen.seq, limit: Option.none(), kinds: [] }).pipe(
      Effect.catchTag("SessionMissing", removed),
      Effect.map((events) => events.filter((event) => event.seq <= head.seq)),
    )
    const ours = Option.exists(state.open, (open) => open.turn === admitted.turn && open.holder === input.instance)
    if (!ours) {
      yield* close(reasonIn(yield* since.pipe(Effect.catchTag("SessionLogError", () => Effect.succeed([])))))
      return false
    }
    const events = yield* since
    yield* Ref.update(foreign, (all) => [...all, ...events])
    yield* Ref.set(position, { revision: head.revision, seq: head.seq, state, storageAt: head.now, localAt: yield* Clock.currentTimeMillis })
    return true
  }).pipe(Effect.catchTag("SessionLogError", (error) => Effect.fail(harness("session.log", error.message))))

  /**
   * One guarded commit of what `plan` decides from the current position and
   * the others' events; decided again after each conflict.
   */
  const commitPlan = <A, E>(plan: (at: Position, others: ReadonlyArray<SessionLogEvent>) => Effect.Effect<Plan<A>, E>, options: { readonly renew: boolean }): Effect.Effect<Decided<A>, E | HarnessError> => {
    const attempt = (tries: number): Effect.Effect<Decided<A>, E | HarnessError> => Effect.gen(function* () {
      yield* refuseIfFailed
      yield* refuseIfEnded
      const at = yield* Ref.get(position)
      const decided = yield* plan(at, yield* Ref.get(foreign))
      const now = yield* storageNow
      const next = options.renew ? renewed(decided.next, now, false) : decided.next
      const notAfter = ownership.mode === "lease" ? Option.flatMap(at.state.open, (open) => open.expiresAt) : Option.none()
      const outcome = yield* Effect.result(log.commit(id, {
        expect: at.revision, notAfter, events: stamped(decided.drafts),
        state: next === at.state ? Option.none() : Option.some(stateJson(next)),
      }))
      if (outcome._tag === "Success") {
        const committed = outcome.success
        yield* Ref.set(position, { revision: committed.revision, seq: committed.seq, state: next, storageAt: committed.at, localAt: yield* Clock.currentTimeMillis })
        yield* input.wake
        return { result: decided.result, events: committed.events }
      }
      const error = outcome.failure
      if (error._tag === "RevisionConflict") {
        if (!(yield* rebase(at))) return yield* Effect.fail(harness("turn.closed", `turn ${admitted.turn} was closed elsewhere`))
        return tries + 1 >= config.retries
          ? yield* Effect.fail(harness("session.contended", `turn ${admitted.turn}: ${config.retries} conflicting writes`))
          : yield* attempt(tries + 1)
      }
      if (error._tag === "LeaseExpired") {
        yield* close("interrupted")
        return yield* Effect.fail(harness("turn.closed", `turn ${admitted.turn}'s lease ran out`))
      }
      if (error._tag === "SessionMissing") {
        yield* close("removed")
        return yield* Effect.fail(harness("turn.closed", "the session was removed"))
      }
      return yield* Effect.fail(harness("session.log", error.message))
    })
    return attempt(0)
  }

  /** A failed store write latches: the turn fails at its next touch of the writer. */
  const latch = <A>(effect: Effect.Effect<A, HarnessError>): Effect.Effect<Option.Option<A>> => effect.pipe(
    Effect.map(Option.some),
    Effect.catch((error) => Ref.update(failed, Option.orElse(() => Option.some(error))).pipe(Effect.as(Option.none()))),
  )

  const unchanged = <A>(result: A, drafts: ReadonlyArray<TurnDraft>) => (at: Position) => Effect.succeed<Plan<A>>({ drafts, next: at.state, result })

  const process = (item: Item): Effect.Effect<void> => item._tag === "Tracked" ? process(item.item).pipe(Effect.ensuring(item.settled)) : Ref.get(failed).pipe(Effect.flatMap((failure) => {
    if (item._tag === "Marker") return Option.match(failure, { onNone: () => Deferred.succeed(item.done, undefined), onSome: (error) => Deferred.fail(item.done, error) }).pipe(Effect.asVoid)
    if (item._tag === "Run" || item._tag === "Commit") return item._tag === "Run" ? item.run : item.commit
    return Option.isSome(failure) ? Effect.void : latch(commitPlan(unchanged(undefined, item.drafts), { renew: true })).pipe(Effect.asVoid)
  }))

  yield* Effect.forkIn(Queue.takeBetween(queue, 1, config.writer.batch).pipe(
    Effect.flatMap((chunk) => Effect.forEach(groupsOf(chunk), process, { discard: true })),
    Effect.forever,
  ), scope)

  const offer = (item: Item): Effect.Effect<void, HarnessError> => Queue.offer(queue, item).pipe(
    Effect.flatMap((accepted) => accepted ? Effect.void : Effect.fail(harness("turn.closed", `turn ${admitted.turn}'s scope closed`))),
  )

  /** Keep every result reachable until it settles, including an item already taken by the consumer. */
  const enqueue = <A, E>(result: Deferred.Deferred<A, E | HarnessError>, item: Item): Effect.Effect<void, HarnessError> => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const refuse = (error: HarnessError) => Deferred.fail(result, error).pipe(Effect.asVoid)
    const settled = Ref.update(waiting, (all) => new Set([...all].filter((entry) => entry !== refuse)))
    yield* Ref.update(waiting, (all) => new Set([...all, refuse]))
    yield* restore(offer({ _tag: "Tracked", item, settled })).pipe(
      Effect.onInterrupt(() => refuse(harness("turn.closed", `turn ${admitted.turn}'s scope closed`)).pipe(Effect.andThen(settled))),
      Effect.tapError((error) => refuse(error).pipe(Effect.andThen(settled))),
    )
  }))

  const admit = <A, E>(result: Deferred.Deferred<A, E | HarnessError>, item: Item) => admission.withPermits(1)(
    refuseIfFailed.pipe(Effect.andThen(refuseIfSealed), Effect.andThen(enqueue(result, item))),
  )

  /** Queue `commit` and wait for its result, in queue order. */
  const inOrder = <A, E>(commit: Effect.Effect<A, E | HarnessError>): Effect.Effect<A, E | HarnessError> => Effect.gen(function* () {
    const result = yield* Deferred.make<A, E | HarnessError>()
    yield* admit(result, { _tag: "Commit", commit: Effect.exit(commit).pipe(Effect.flatMap((exit) => Deferred.done(result, exit)), Effect.asVoid) })
    return yield* Deferred.await(result)
  })

  const flush: Effect.Effect<void, HarnessError> = Deferred.make<void, HarnessError>().pipe(Effect.flatMap((done) =>
    admission.withPermits(1)(refuseIfFailed.pipe(Effect.andThen(enqueue(done, { _tag: "Marker", done })))).pipe(Effect.andThen(Deferred.await(done)))))

  const endNow = (ending: TurnEnding): Effect.Effect<{ readonly pending: number }, HarnessError> => Effect.gen(function* () {
    const done = yield* commitPlan((at) => Effect.gen(function* () {
      const after = closedState(at.state, ending.reason, config.inbox.attempts)
      const closing = yield* turnEndedDraft(admitted.turn, ending).pipe(Effect.mapError((error) => harness("session.encode", error.message)))
      const dropped = after.dropped.map((item): TurnDraft => ({ kind: "inbox.dropped", data: { id: item, reason: "attempts" } }))
      return { drafts: [{ kind: closing.kind, data: closing.data }, ...dropped], next: after.state, result: pendingOf(after.state).length }
    }), { renew: false })
    yield* Ref.set(ended, true)
    return { pending: done.result }
  })

  /** Admission reopens: no end is under way, and a later one tries again. */
  const reopen = Ref.set(ending, Option.none()).pipe(Effect.andThen(Ref.set(sealed, false)))

  /**
   * Settle an end's shared result. A stored end, or a turn closed elsewhere,
   * is final; after any other failure (a store error, contention) admission
   * reopens first, so a later end (the scope's own, at the latest) tries again.
   */
  const settleEnd = (done: Deferred.Deferred<{ readonly pending: number }, HarnessError>, exit: Exit.Exit<{ readonly pending: number }, HarnessError>) =>
    (Exit.isSuccess(exit) || Option.exists(Exit.findErrorOption(exit), (error) => error.code === "turn.closed") ? Effect.void : reopen).pipe(
      Effect.andThen(Deferred.done(done, exit)), Effect.asVoid)

  /** The first end seals admission before it is offered; every end while it runs awaits that same commit. */
  const end = (value: TurnEnding): Effect.Effect<{ readonly pending: number }, HarnessError> => Effect.gen(function* () {
    const result = yield* admission.withPermits(1)(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const current = yield* Ref.get(ending)
      if (Option.isSome(current)) return current.value
      yield* refuseIfFailed
      const done = yield* Deferred.make<{ readonly pending: number }, HarnessError>()
      yield* Ref.set(sealed, true)
      yield* Ref.set(ending, Option.some(done))
      yield* restore(enqueue(done, { _tag: "Commit", commit: Effect.exit(endNow(value)).pipe(Effect.flatMap((exit) => settleEnd(done, exit))) })).pipe(
        Effect.onInterrupt(() => reopen),
      )
      return done
    })))
    return yield* Deferred.await(result)
  })

  // A keep-alive extends the lease between writes; when it is refused, the turn was closed elsewhere.
  if (ownership.mode === "lease" && typeof ownership.renew === "object") {
    const renew = inOrder(commitPlan((at) => Effect.gen(function* () {
      return { drafts: [], next: renewed(at.state, yield* storageNow, true), result: undefined }
    }), { renew: false })).pipe(Effect.ignore)
    yield* Effect.forkIn(renew.pipe(Effect.repeat(Schedule.spaced(`${ownership.renew.everyMs} millis`)), Effect.asVoid), scope)
  }

  // Runs first when the scope closes (finalizers run last-added first): a turn never ended ends as failed or interrupted.
  yield* Scope.addFinalizerExit(scope, (exit) => Ref.get(ended).pipe(Effect.flatMap((done) => done ? Effect.void
    : end({
      reason: Exit.hasInterrupts(exit) ? "interrupted" : "failed",
      failure: Option.some({ code: "turn.unended", message: "the turn's scope closed before it ended" }),
    }).pipe(Effect.timeout("10 seconds"), Effect.ignore)), Effect.ensuring(Effect.gen(function* () {
      yield* Ref.set(sealed, true)
      yield* Ref.update(failed, Option.orElse(() => Option.some(harness("turn.closed", `turn ${admitted.turn}'s scope closed`))))
      yield* Queue.shutdown(queue)
      yield* Effect.forEach(yield* Ref.get(waiting), (refuse) => refuse(harness("turn.closed", `turn ${admitted.turn}'s scope closed`)), { discard: true })
    }))))

  const writer: TurnWriter = {
    admitted,
    started: input.started,
    history: (kinds) => historyOf(log, input.header, input.started, kinds),
    snapshot: (kinds) => flush.pipe(Effect.andThen(historyOf(log, input.header, input.started, kinds, true))),
    append: (drafts) => admission.withPermits(1)(refuseIfFailed.pipe(Effect.andThen(refuseIfSealed), Effect.andThen(drafts.length === 0 ? Effect.void : offer({ _tag: "Append", drafts })))),
    write: <A, E>(op: Effect.Effect<A, E>) => Effect.gen(function* () {
      const result = yield* Deferred.make<A, E | HarnessError>()
      const run = Effect.exit(Effect.raceFirst(
        refuseIfFailed.pipe(Effect.andThen(refuseIfEnded), Effect.andThen(op)),
        Deferred.await(closed).pipe(Effect.flatMap((note) => Effect.fail(harness("turn.closed", `turn ${admitted.turn} was ${note.reason}`)))),
      )).pipe(Effect.flatMap((exit) => Deferred.done(result, exit)), Effect.asVoid)
      yield* admit(result, { _tag: "Run", run })
      return yield* Deferred.await(result)
    }),
    transact: <A, E>(decide: (others: ReadonlyArray<SessionLogEvent>) => Effect.Effect<Decision<A>, E>) =>
      inOrder(commitPlan((at, others) => decide(others).pipe(Effect.map((decision): Plan<A> => ({ drafts: decision.drafts, next: at.state, result: decision.result }))), { renew: true })),
    flush,
    end,
    closed: Deferred.await(closed),
  }
  return { writer, close, ended: Ref.get(ended) }
})

/** A session's events before `started`, its fork's parent (up to the fork point) first. */
const historyOf = (log: Log, header: SessionHeader, started: SessionLogEvent, kinds: ReadonlyArray<string>, includeCurrent = false): Effect.Effect<ReadonlyArray<SessionLogEvent>, HarnessError> => {
  const ancestors = (lineage: SessionHeader["parent"]): Effect.Effect<ReadonlyArray<SessionLogEvent>, HarnessError> => Option.match(lineage, {
    onNone: () => Effect.succeed([]),
    onSome: (parent) => parent.through <= 0 ? Effect.succeed([]) : Effect.gen(function* () {
      const head = yield* log.head(parent.id).pipe(Effect.mapError((error) => harness("session.log", `the fork's parent: ${error._tag}`)))
      const earlier = yield* ancestors(head.header.parent)
      const events = yield* log.read(parent.id, { after: 0, limit: Option.none(), kinds }).pipe(Effect.mapError((error) => harness("session.log", error._tag)))
      return [...earlier, ...events.filter((event) => event.seq <= parent.through)]
    }),
  })
  return Effect.gen(function* () {
    const inherited = yield* ancestors(header.parent)
    const own = yield* log.read(header.id, { after: 0, limit: Option.none(), kinds }).pipe(Effect.mapError((error) => harness("session.log", error._tag)))
    return [...inherited, ...own.filter((event) => includeCurrent || event.seq < started.seq)]
  })
}
