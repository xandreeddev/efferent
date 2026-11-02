import { Cause, Clock, Deferred, Effect, Exit, Layer, Match, Option, PubSub, Ref, Schema, Stream, SubscriptionRef } from "effect"
import type { Scope } from "effect"
import {
  canonicalJson, DrainActivity, HarnessError, harnessDefectsAsFailures, InboxDroppedData, InboxRunner, InboxTakenData,
  isShutdownRefusal, RunId, SessionLogError, Sessions, sessionAttributes, TurnActivity, TurnEndedData, TurnShutdown, turnEndingOf,
} from "@xandreed/core"
import type { BeginTurn, ConversationId, OpenTurn, SessionAddress, SessionListCursor, SessionLogEvent, SessionMissing, SessionView, TurnBeginError, TurnError } from "@xandreed/core"
import {
  claimDrain, drainHistoryOf, drainKeyOf, emptyDrainScheduler, finishDrain, isParked, nextDrainDelay, observeDrains,
  resumeMessageOf, targetIdentity, targetOf, targetPending,
} from "./inbox-drain.entity.functions.js"
import { DrainAttempt, DrainQueuedData, DrainStartedData, inboxDrainDefaults, InboxDrainConfig } from "./inbox-drain.entity.js"
import type { DrainEvent, DrainHistory, DrainJob, DrainPolicy, DrainTakeover, DrainTarget, InboxDrainOptions } from "./inbox-drain.entity.js"

const kinds = ["inbox.queued", "inbox.taken", "inbox.dropped", "turn.started", "turn.ended"]
const decodeError = (cause: Schema.SchemaError) => new SessionLogError({ code: "session.decode", message: "the inbox drainer could not decode a session record", cause })
const eventOf = (event: SessionLogEvent): Effect.Effect<Option.Option<DrainEvent>, SessionLogError> => {
  const numbered = (read: (turn: number) => Effect.Effect<DrainEvent, Schema.SchemaError>) => Option.match(event.turn, {
    onNone: () => Effect.fail(new SessionLogError({ code: "session.decode", message: "an inbox-drain turn record has no turn number" })),
    onSome: (turn) => read(turn).pipe(Effect.map(Option.some), Effect.mapError(decodeError)),
  })
  return Match.value(event.kind).pipe(
    Match.when("inbox.queued", () => Schema.decodeUnknownEffect(DrainQueuedData)(event.data).pipe(Effect.map((data): Option.Option<DrainEvent> => Option.some({ _tag: "Enqueued", id: data.id, delivery: Option.map(Option.fromNullishOr(data.input), (input) => input.delivery) })), Effect.mapError(decodeError))),
    Match.when("inbox.taken", () => Schema.decodeUnknownEffect(InboxTakenData)(event.data).pipe(Effect.map((data): Option.Option<DrainEvent> => Option.some({ _tag: "Removed", id: data.id })), Effect.mapError(decodeError))),
    Match.when("inbox.dropped", () => Schema.decodeUnknownEffect(InboxDroppedData)(event.data).pipe(Effect.map((data): Option.Option<DrainEvent> => Option.some({ _tag: "Removed", id: data.id })), Effect.mapError(decodeError))),
    Match.when("turn.started", () => numbered((turn) => Schema.decodeUnknownEffect(DrainStartedData)(event.data).pipe(Effect.map((data): DrainEvent => ({ _tag: "Started", turn, runId: data.runId, origin: data.origin, claimed: data.claimed, input: Option.fromNullishOr(data.input), resumes: Option.fromNullishOr(data.resumes) }))))),
    Match.when("turn.ended", () => numbered((turn) => Schema.decodeUnknownEffect(TurnEndedData)(event.data).pipe(Effect.map((data): DrainEvent => ({
      _tag: "Ended", turn, reason: data.reason, code: Option.map(data.failure, (failure) => failure.code), seq: event.seq,
    }))))),
    Match.orElse(() => Effect.succeedNone),
  )
}

/** What changes a session's target without a commit it signals: a new commit, or its open turn held or let go. */
const markOf = (view: SessionView): string => canonicalJson([view.seq, Option.match(view.open, { onNone: () => null, onSome: (open) => [open.turn, open.runId] })])

/** The open turn a startup sweep saw, the only one its takeover may close. */
const takeoverOf = (open: OpenTurn): DrainTakeover => ({ turn: open.turn, runId: open.runId })

/**
 * Run explicit owner scopes on fixed scoped workers. Wakes coalesce; periodic
 * scans find foreign commits and read only sessions that changed since the
 * last scan. Takeover authority is consumed by startup work, and names the
 * turn that sweep saw open, never one this instance holds.
 * @public
 */
export const InboxDrainLive = (options: InboxDrainOptions): Layer.Layer<DrainActivity, HarnessError, Sessions | InboxRunner> => Layer.effect(DrainActivity, Effect.gen(function* () {
  const config = yield* Schema.decodeUnknownEffect(InboxDrainConfig)({ ...inboxDrainDefaults, ...options }).pipe(
    Effect.mapError((cause) => new HarnessError({ code: "config.options", message: "invalid inbox drainer options", cause })),
  )
  const sessions = yield* Sessions
  const runner = yield* InboxRunner
  const shutdown = yield* Effect.serviceOption(TurnShutdown)
  const halted = yield* Ref.make(false)
  const stopping = Ref.get(halted).pipe(Effect.flatMap((stopped) => stopped ? Effect.succeed(true) : Option.match(shutdown, { onNone: () => Effect.succeed(false), onSome: (service) => service.stopping })))
  const scheduler = yield* Ref.make(emptyDrainScheduler)
  const running = yield* SubscriptionRef.make(0)
  const startup = yield* Ref.make(true)
  const subscribed = yield* Deferred.make<void>()
  const scanWake = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown)
  const workWake = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown)
  // This subscription exists before the Sessions.waiting consumer can send its
  // first post-subscription wake; commits during the sweep leave another token.
  const scanSub = yield* PubSub.subscribe(scanWake)
  const turns = yield* Effect.serviceOption(TurnActivity)
  /** Per session, its last sequence number the startup sweep saw: interruptions at or before it happened to an earlier process. */
  const baselines = yield* Ref.make<ReadonlyMap<string, number>>(new Map())
  /** Per session the last scan selected, what it saw (`markOf`) and the target it found, reused while nothing changed. */
  const scanned = yield* Ref.make<ReadonlyMap<string, { readonly mark: string; readonly target: Option.Option<DrainTarget> }>>(new Map())

  /** Whether this instance holds the turn (its own work, begun here): never taken over. */
  const heldHere = (address: SessionAddress, open: OpenTurn) => Option.match(turns, {
    onNone: () => Effect.succeed(false),
    onSome: (probe) => probe.current.pipe(Effect.map((now) => now.open.some((active) => active.session === address.id && active.turn === open.turn))),
  })

  const select = Effect.fnUntraced(function* (address: SessionAddress, view: SessionView, takeOver: Option.Option<DrainTakeover>): Effect.fn.Return<{
    readonly target: Option.Option<DrainTarget>; readonly history: DrainHistory; readonly policy: DrainPolicy; readonly takeOver: Option.Option<DrainTakeover>
  }, SessionLogError | SessionMissing> {
    const events = yield* sessions.read(address, { kinds })
    const facts = yield* Effect.forEach(events, eventOf, { concurrency: 1 })
    const history = drainHistoryOf(facts.flatMap(Option.toArray))
    const policy: DrainPolicy = { resume: config.resume, attempts: config.attempts, baseline: Option.fromNullishOr((yield* Ref.get(baselines)).get(drainKeyOf(address))) }
    // Take over exactly the turn the startup sweep saw, if it is still the open one and not this instance's own.
    const seen = Option.filter(takeOver, (named) => Option.exists(view.open, (open) => open.turn === named.turn && open.runId === named.runId))
    const granted = Option.isSome(seen) && Option.isSome(view.open) && !(yield* heldHere(address, view.open.value)) ? seen : Option.none<DrainTakeover>()
    return { target: targetOf(history, view.open, policy, Option.isSome(granted)), history, policy, takeOver: granted }
  })

  const discover = Effect.fnUntraced(function* (first: boolean) {
    const seen = yield* Ref.make<ReadonlySet<string>>(new Set())
    const pages = (owner: string, parent: Option.Option<ConversationId>, before: Option.Option<SessionListCursor>): Effect.Effect<ReadonlyArray<SessionView>, SessionLogError> => Effect.gen(function* () {
      const page = yield* sessions.list({ owner, limit: config.pageSize, ...Option.match(parent, { onNone: () => ({}), onSome: (value) => ({ parent: value }) }), ...Option.match(before, { onNone: () => ({}), onSome: (value) => ({ before: value }) }) })
      const fresh = yield* Ref.modify(seen, (known): readonly [ReadonlyArray<SessionView>, ReadonlySet<string>] => {
        const next = page.sessions.filter((view) => !known.has(drainKeyOf({ owner, id: view.header.id })))
        return [next, new Set([...known, ...next.map((view) => drainKeyOf({ owner, id: view.header.id }))])]
      })
      const children = yield* Effect.forEach(fresh, (view) => pages(owner, Option.some(view.header.id), Option.none()), { concurrency: 1 })
      const rest = yield* Option.match(page.next, { onNone: () => Effect.succeed<ReadonlyArray<SessionView>>([]), onSome: (cursor) => pages(owner, parent, Option.some(cursor)) })
      return [...fresh, ...children.flat(), ...rest]
    })
    const owners = yield* Effect.forEach([...new Set(config.owners)], (owner) => pages(owner, Option.none(), Option.none()).pipe(
      Effect.tapError((error) => Effect.logWarning("an inbox-drain owner scan failed", error)),
      Effect.catch(() => Effect.succeed<ReadonlyArray<SessionView>>([])),
      Effect.map((views) => views.map((view) => ({ address: { owner, id: view.header.id }, view }))),
    ), { concurrency: config.concurrency })
    const listed = owners.flat()
    if (first) yield* Ref.set(baselines, new Map(listed.map(({ address, view }) => [drainKeyOf(address), view.seq])))
    const before = yield* Ref.get(scanned)
    const selected = yield* Effect.forEach(listed, ({ address, view }) => {
      const key = drainKeyOf(address)
      const mark = markOf(view)
      const cached = first ? undefined : before.get(key)
      if (cached !== undefined && cached.mark === mark) return Effect.succeed([{ key, mark, address, target: cached.target, takeOver: Option.none<DrainTakeover>() }])
      const takeOver = first && config.takeOver ? Option.map(view.open, takeoverOf) : Option.none<DrainTakeover>()
      return select(address, view, takeOver).pipe(
        Effect.map((selection) => [{ key, mark, address, target: selection.target, takeOver: selection.takeOver }]),
        Effect.catchTag("SessionMissing", () => Effect.succeed([])),
        Effect.tapError((error) => Effect.logWarning("an inbox-drain session scan failed", error).pipe(Effect.annotateLogs(sessionAttributes(address.id)))),
        Effect.catch(() => Effect.succeed([])),
      )
    }, { concurrency: config.concurrency })
    const found = selected.flat()
    yield* Ref.set(scanned, new Map(found.map(({ key, mark, target }) => [key, { mark, target }])))
    return found.flatMap(({ address, target, takeOver }) => Option.toArray(Option.map(target, (value) => ({ address, target: value, takeOver }))))
  })

  const attempt = Effect.fn("inbox_drain.attempt")(function* (job: DrainJob): Effect.fn.Return<DrainAttempt, TurnBeginError | TurnError | SessionMissing, Scope.Scope> {
    const selection = yield* select(job.address, yield* sessions.get(job.address), job.takeOver)
    const parked = isParked(selection.history, job.target, selection.policy)
    const stale = Option.isNone(selection.target) || targetIdentity(selection.target.value) !== targetIdentity(job.target)
    if (stale && parked) yield* Effect.logWarning(`the inbox drainer parked work after ${config.attempts} unsuccessful runs or a deliberate stop; it stays queued until the host runs or cancels it`).pipe(
      Effect.annotateLogs({ "efferent.drain.target": targetIdentity(job.target) }))
    if (Option.isNone(selection.target)) return targetPending(selection.history, job.target, selection.policy)
      ? { _tag: "Retry", target: job.target } : { _tag: "Done" }
    if (stale) return { _tag: "Done" }
    const target = selection.target.value
    const runId = RunId.make(yield* Effect.sync(() => crypto.randomUUID()))
    const takeOver = Option.match(selection.takeOver, { onNone: () => ({}), onSome: (named) => ({ takeOver: named }) })
    const input: BeginTurn = Match.value(target).pipe(Match.tagsExhaustive({
      Resume: (value): BeginTurn => ({ _tag: "User", runId, key: `drain-resume:${canonicalJson([value.turn, value.after, runId])}`, resumes: value.turn,
        userMessage: config.resume._tag === "Before" ? resumeMessageOf(config.resume) : resumeMessageOf({ _tag: "Before" }), command: {}, ...takeOver,
      }),
      Queued: (value): BeginTurn => ({ _tag: "Queued", runId, input: value.input, ...takeOver }),
      Inbox: (): BeginTurn => ({ _tag: "Inbox", runId, ...takeOver }),
    }))
    const writer = yield* sessions.begin(job.address, input)
    const exit = yield* Effect.exit(harnessDefectsAsFailures(runner.run(writer)).pipe(
      Effect.raceFirst(writer.closed.pipe(Effect.flatMap((closed) => Effect.fail(closed)))),
    ))
    const ending = turnEndingOf(exit)
    // A runner that interrupted itself tried what it took, even having written
    // nothing: an empty transact counts that write, as Sessions.drain does, so
    // a notice uses up its attempts and is not taken again forever.
    if (ending.reason === "interrupted") yield* writer.transact(() => Effect.succeed({ drafts: [], result: undefined }))
    yield* writer.end(ending)
    // The writer's successful end ACK is the authority. A handoff may fail or
    // be skipped on process death; it cannot make consumed input run again.
    if (runner.afterEnd !== undefined) yield* runner.afterEnd(writer, ending).pipe(
      Effect.interruptible,
      Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.logWarning("an inbox-drain post-end handoff failed", cause)),
    )
    yield* Option.match(ending.failure, { onNone: () => Effect.void, onSome: (error) => Effect.logWarning("an inbox-drain turn did not complete", error) })
    return ending.reason === "completed" || ending.reason === "cancelled" || ending.reason === "waiting" ? { _tag: "Done" } : { _tag: "Retry", target }
  }, (effect, job) => Effect.annotateLogs(effect, sessionAttributes(job.address.id)))

  const run = (job: DrainJob): Effect.Effect<DrainAttempt> => Effect.scoped(attempt(job)).pipe(
    Effect.catchTags({
      SessionMissing: () => Effect.succeed<DrainAttempt>({ _tag: "Done" }),
      NothingPending: () => Effect.succeed<DrainAttempt>({ _tag: "Done" }),
      // Another holder may have failed its claim after selection. Keep this
      // payload's backoff until a fresh attempt proves it was acknowledged.
      TurnDuplicate: () => Effect.succeed<DrainAttempt>({ _tag: "Retry", target: job.target }),
      NotResumable: () => Effect.succeed<DrainAttempt>({ _tag: "Done" }),
      TurnClosed: (closed) => Effect.logDebug("an inbox-drain writer closed before its runner returned", closed).pipe(Effect.as<DrainAttempt>({ _tag: "Retry", target: job.target })),
      TurnRefused: (error) => isShutdownRefusal(error) ? Effect.succeed<DrainAttempt>({ _tag: "Stopped" }) : Effect.fail(error),
    }),
    Effect.catchCause((cause) => Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.logWarning("an inbox-drain attempt failed", cause).pipe(Effect.as<DrainAttempt>({ _tag: "Retry", target: job.target }))),
  )

  yield* Effect.forEach(Array.from({ length: config.concurrency }), () => Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(workWake)
    yield* Effect.forever(Effect.gen(function* () {
      if (yield* stopping) return yield* Effect.never
      const now = yield* Clock.currentTimeMillis
      const job = yield* Ref.modify(scheduler, (state) => claimDrain(state, now))
      if (Option.isNone(job)) {
        const delay = nextDrainDelay(yield* Ref.get(scheduler), now, config.sweepIntervalMs)
        return yield* Effect.raceFirst(PubSub.take(subscription), Effect.sleep(delay)).pipe(Effect.asVoid)
      }
      const result = yield* SubscriptionRef.update(running, (count) => count + 1).pipe(
        Effect.andThen(run(job.value)), Effect.ensuring(SubscriptionRef.update(running, (count) => count - 1)),
      )
      const at = yield* Clock.currentTimeMillis
      yield* Ref.update(scheduler, (state) => finishDrain(state, job.value, DrainAttempt.isAnyOf(["Retry"])(result) ? Option.some(result.target) : Option.none(), result._tag === "Retry", at, config.backoff))
      if (result._tag === "Stopped") yield* Ref.set(halted, true)
      yield* PubSub.publish(scanWake, undefined)
    }))
  }).pipe(Effect.forkScoped), { concurrency: 1, discard: true })

  yield* Effect.forever(PubSub.take(scanSub).pipe(Effect.andThen(Effect.gen(function* () {
    const first = yield* Ref.getAndSet(startup, false)
    const candidates = yield* discover(first)
    yield* Ref.update(scheduler, (state) => observeDrains(state, candidates, first && config.takeOver))
    yield* PubSub.publish(workWake, undefined)
  })))).pipe(Effect.forkScoped)
  yield* Stream.runForEach(sessions.waiting, () => Deferred.succeed(subscribed, undefined).pipe(Effect.andThen(PubSub.publish(scanWake, undefined)))).pipe(Effect.forkScoped)
  yield* Deferred.await(subscribed).pipe(Effect.andThen(Effect.forever(Effect.sleep(config.sweepIntervalMs).pipe(Effect.andThen(PubSub.publish(scanWake, undefined))))), Effect.forkScoped)
  return DrainActivity.of({ running: SubscriptionRef.get(running), idle: SubscriptionRef.changes(running).pipe(Stream.filter((count) => count === 0), Stream.take(1), Stream.runDrain) })
}))
