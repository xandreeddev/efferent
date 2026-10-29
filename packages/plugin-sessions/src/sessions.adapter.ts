import { Clock, Context, Effect, Exit, Layer, Option, PubSub, Ref, Schema, Scope, Stream, SubscriptionRef } from "effect"
import {
  canonicalJson,
  ConversationId,
  EntryId,
  HarnessError,
  harnessDefectsAsFailures,
  InboxFull,
  KeyConflict,
  normalizeUserMessage,
  NothingPending,
  NotResumable,
  RESERVED_KINDS,
  resumeRefusal,
  ReservedKind,
  RunIdReused,
  sameUserMessage,
  SessionBusy,
  SessionLog,
  SessionLogError,
  SessionMissing,
  Sessions,
  TurnActivity,
  TurnAdmission,
  TurnDuplicate,
  turnEndedDraft,
  turnEndedOf,
  turnEndingOf,
  turnStartedDraft,
  turnStartedOf,
  UserMessage,
} from "@xandreed/core"
import type {
  ActiveTurn,
  AdmittedTurn,
  AttachmentRejected,
  BeginTurn,
  InboxItem,
  JsonObject,
  ResumableTurn,
  SessionAddress,
  SessionCommitted,
  SessionDraft,
  SessionHead,
  SessionLogEvent,
  TurnDraft,
  TurnWriter,
} from "@xandreed/core"
import { processLiveness } from "./process-liveness.adapter.js"
import { closedState, droppedData, heldTurn, pendingOf, queuedData, stateJson, stateOf, titleOf, turnLogIds, viewOf } from "./sessions-state.entity.functions.js"
import type { Holder } from "./sessions-state.entity.functions.js"
import { Ownership } from "./sessions-state.entity.js"
import type { HeldTurn, ProcessLiveness, SessionsConfig, SessionsState } from "./sessions-state.entity.js"
import { makeTurnWriter } from "./turn-writer.adapter.js"
import type { OpenWriter } from "./turn-writer.adapter.js"

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

const storage = (code: string) => (error: { readonly message: string }) => new SessionLogError({ code, message: error.message })

/** The `inbox.dropped` drafts of turn `turn` for the items its close dropped. */
const droppedDrafts = (ids: ReadonlyArray<string>, turn: number): Effect.Effect<ReadonlyArray<SessionDraft>, SessionLogError> =>
  Effect.forEach(ids, (id) => droppedData(id).pipe(
    Effect.map((data): SessionDraft => ({ kind: "inbox.dropped", turn: Option.some(turn), data })),
    Effect.mapError(storage("session.encode")),
  ), { concurrency: 1 })

const standalone = (drafts: ReadonlyArray<TurnDraft>): ReadonlyArray<SessionDraft> =>
  drafts.map((draft) => ({ kind: draft.kind, turn: Option.none(), data: draft.data }))

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
 * its writer's scope closes. An ownership the schema
 * refuses (a keep-alive slower than half the lease) fails the layer with
 * `config.options`.
 */
export const SessionsLive = (config: SessionsConfig, options?: { readonly liveness?: ProcessLiveness }): Layer.Layer<Sessions | TurnActivity, HarnessError, SessionLog | TurnAdmission> => Layer.effectContext(Effect.gen(function* () {
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
  const signals = yield* PubSub.unbounded<string>()
  /** The writer this instance holds per session, for a local cancel or removal. */
  const writers = yield* Ref.make(new Map<string, OpenWriter & { readonly turn: number }>())
  const inFlight = yield* SubscriptionRef.make<InFlight>({ held: new Map(), beginning: 0 })
  const heldKey = (id: string, turn: number) => `${id}:${turn}`
  const beginSettled = SubscriptionRef.update(inFlight, (now): InFlight => ({ ...now, beginning: now.beginning - 1 }))
  const wake = (id: string) => PubSub.publish(signals, id).pipe(Effect.asVoid)
  const freshId = Effect.sync(() => ConversationId.make(crypto.randomUUID()))

  const stateFrom = (head: SessionHead) => stateOf(head).pipe(Effect.mapError(storage("session.state")))
  const owned = (address: SessionAddress) => log.head(address.id).pipe(Effect.flatMap((head) =>
    head.header.owner === address.owner ? Effect.succeed(head) : Effect.fail(new SessionMissing({ session: address.id }))))
  const viewFrom = (head: SessionHead) => stateFrom(head).pipe(Effect.flatMap((state) => viewOf(head, state, holder)))

  /**
   * Plan from the head and commit it, against the revision planned from;
   * after a conflict, plan again. The commit is not interrupted half way,
   * and `stored` runs with it: an interruption waits for the store's answer
   * and for what must follow a stored commit.
   */
  const guarded = <A, E>(address: SessionAddress, plan: (head: SessionHead, state: SessionsState) => Effect.Effect<GuardedPlan<A>, E>, stored: (result: A) => Effect.Effect<void> = () => Effect.void) => {
    const attempt = (tries: number): Effect.Effect<Guarded<A>, E | SessionMissing | SessionLogError> => Effect.gen(function* () {
      const head = yield* owned(address)
      const planned = yield* plan(head, yield* stateFrom(head))
      if (planned.drafts.length === 0 && Option.isNone(planned.next)) return { result: planned.result, head, committed: Option.none() }
      const state = yield* Option.match(planned.next, {
        onNone: () => Effect.succeedNone,
        onSome: (next) => stateJson(next).pipe(Effect.map(Option.some), Effect.mapError(storage("session.encode"))),
      })
      const outcome = yield* Effect.uninterruptible(Effect.result(log.commit(address.id, {
        expect: head.revision, notAfter: Option.none(), events: planned.drafts, state,
      })).pipe(Effect.tap((result) => result._tag === "Success" ? stored(planned.result) : Effect.void)))
      if (outcome._tag === "Success") {
        yield* Option.match(planned.next, { onNone: () => Effect.void, onSome: (next) => forgetClosed(address.id, next) })
        yield* wake(address.id)
        return { result: planned.result, head, committed: Option.some(outcome.success) }
      }
      const error = outcome.failure
      if (error._tag === "RevisionConflict") {
        return tries + 1 >= config.retries
          ? yield* Effect.fail(new SessionLogError({ code: "session.contended", message: `${config.retries} conflicting writes to ${address.id}` }))
          : yield* attempt(tries + 1)
      }
      return yield* Effect.fail(error._tag === "LeaseExpired" ? new SessionLogError({ code: "session.expired", message: "an unguarded commit expired" }) : error)
    })
    return attempt(0)
  }

  /**
   * An open turn nobody holds any more (its lease ran out, or its process is
   * gone) is closed as interrupted: the drafts that close it, the state
   * after them, and the turn they close.
   */
  const reaped = (head: SessionHead, state: SessionsState) => Effect.gen(function* () {
    if (Option.isNone(state.open) || Option.isSome(yield* heldTurn(head, state, holder))) return { drafts: [] as ReadonlyArray<SessionDraft>, state, closed: Option.none<number>() }
    const turn = state.open.value.turn
    // A reaped turn counts as an attempt: its holder may have stopped on the items.
    const after = closedState(state, "interrupted", config.inbox.attempts, true)
    const closing = yield* turnEndedDraft(turn, { reason: "interrupted", failure: Option.some({ code: "turn.lease", message: "the turn's holder stopped writing" }) })
      .pipe(Effect.mapError(storage("session.encode")))
    const dropped = yield* droppedDrafts(after.dropped, turn)
    return { drafts: [closing, ...dropped], state: after.state, closed: Option.some(turn) }
  })

  /** A session's own `turn.started` events. */
  const startsOf = (id: ConversationId) => log.read(id, { after: 0, limit: Option.none(), kinds: ["turn.started"] })

  /** Of these `turn.started` events, the turn begun with `key`, and what it was begun with. */
  const keyIn = (starts: ReadonlyArray<SessionLogEvent>, key: string) =>
    Option.map(Option.fromNullishOr(starts.find((event) => event.data.key === key)), (event) => ({ turn: Option.getOrElse(event.turn, () => 0), event }))

  /** The turn begun with `key`, and what it was begun with. */
  const keyed = (id: ConversationId, key: string) => startsOf(id).pipe(Effect.map((starts) => keyIn(starts, key)))

  /**
   * The turn begun under `runId`: of the session's own `turn.started` events
   * (`starts`), or of the history a fork inherits (each parent up to its fork
   * point). Memory numbers a turn's entries from its run id over that whole
   * history.
   */
  const runOf = (header: SessionHead["header"], starts: ReadonlyArray<SessionLogEvent>, runId: string) => {
    const begunIn = (events: ReadonlyArray<SessionLogEvent>, through: number) =>
      Option.map(Option.fromNullishOr(events.find((event) => event.data.runId === runId && event.seq <= through)), (event) => Option.getOrElse(event.turn, () => 0))
    const inherited = (lineage: SessionHead["header"]["parent"]): Effect.Effect<Option.Option<number>, SessionMissing | SessionLogError> => Option.match(lineage, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (parent) => parent.through <= 0 ? Effect.succeed(Option.none()) : startsOf(parent.id).pipe(
        Effect.flatMap((events) => Option.match(begunIn(events, parent.through), {
          onSome: (turn) => Effect.succeed(Option.some(turn)),
          onNone: () => log.head(parent.id).pipe(Effect.flatMap((head) => inherited(head.header.parent))),
        }))),
    })
    return Option.match(begunIn(starts, Number.POSITIVE_INFINITY), { onSome: (turn) => Effect.succeed(Option.some(turn)), onNone: () => inherited(header.parent) })
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

  /** The inbox items with these ids, as delivered. */
  const inboxItems = (id: ConversationId, ids: ReadonlyArray<string>) => log.read(id, { after: 0, limit: Option.none(), kinds: ["inbox.queued"] }).pipe(
    Effect.map((events) => ids.flatMap((wanted): ReadonlyArray<InboxItem> => Option.toArray(Option.fromNullishOr(events.find((event) => event.data.id === wanted))).map((event) => ({
      id: wanted,
      source: typeof event.data.source === "object" && event.data.source !== null ? event.data.source as Record<string, unknown> : {},
      content: typeof event.data.content === "string" && event.data.content.length > 0 ? event.data.content : `(inbox item ${wanted})`,
    })))),
  )

  /**
   * Close a turn this instance opened whose begin never handed it to a
   * writer (interrupted after its commit). When that commit is not stored
   * either, it is logged and the turn let go of.
   */
  const unhanded = (address: SessionAddress, turn: number, exit: Exit.Exit<unknown, unknown>) => guarded(address, (_head, state) => Effect.gen(function* () {
    if (!Option.exists(state.open, (open) => open.turn === turn && open.holder === instance)) return { drafts: [], next: Option.none<SessionsState>(), result: undefined }
    const interrupted = Exit.hasInterrupts(exit)
    const reason = interrupted ? "interrupted" as const : "failed" as const
    const after = closedState(state, reason, config.inbox.attempts, false)
    const closing = yield* turnEndedDraft(turn, {
      reason,
      failure: Option.some(interrupted
        ? { code: "turn.interrupted", message: "the turn's begin was interrupted before its writer was handed over" }
        : { code: "turn.unended", message: "the turn's scope closed before it ended" }),
    }).pipe(Effect.mapError(storage("session.encode")))
    const dropped = yield* droppedDrafts(after.dropped, turn)
    return { drafts: [closing, ...dropped], next: Option.some(after.state), result: undefined }
  })).pipe(
    Effect.timeout("10 seconds"),
    Effect.tapError(() => letGo(address.id, turn)),
    Effect.ignore({ log: "Warn", message: "a turn whose begin was cut was not closed; this instance lets it go, for the next begin to reap" }),
    Effect.annotateLogs(turnLogIds(address.id, turn)),
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
    const resumes = input._tag === "User" ? Option.fromNullishOr(input.resumes) : Option.none<number>()
    // `resumes` is typed only as a number: one that is not a whole number of at least 1 names no turn, refused before the host's admission sees it.
    const unnumbered = Option.filter(resumes, (turn) => !(Number.isSafeInteger(turn) && turn >= 1))
    if (Option.isSome(unnumbered)) return yield* Effect.fail(new NotResumable({ session: address.id, turn: unnumbered.value, reason: "missing" }))
    // Written only when given, like `meta`: a turn that resumes nothing is stored and admitted as before.
    const resuming = Option.match(resumes, { onNone: () => ({}), onSome: (turn) => ({ resumes: turn }) })
    const toAdmit = { session: address, origin: input._tag === "User" ? "user" as const : "inbox" as const, runId: input.runId, key: input._tag === "User" ? input.key : input.runId, meta, ...resuming }
    const unowned = yield* Ref.make(Option.none<number>())
    yield* SubscriptionRef.update(inFlight, (now): InFlight => ({ ...now, beginning: now.beginning + 1 }))
    yield* Scope.addFinalizerExit(scope, (exit) => Ref.get(unowned).pipe(Effect.flatMap(Option.match({
      onNone: () => Effect.void,
      onSome: (turn) => unhanded(address, turn, exit).pipe(Effect.ensuring(beginSettled)),
    }))))
    return yield* Effect.gen(function* () {
      // Only the opening commit is admitted: the writer's later commits run outside the host's admission.
      const begun = yield* restore(admission.admit(toAdmit, guarded(address, (head, stored) => Effect.gen(function* () {
        const reap = yield* reaped(head, stored)
        const state = reap.state
        const starts = yield* startsOf(address.id)
        if (input._tag === "User") {
          const previous = keyIn(starts, input.key)
          if (Option.isSome(previous)) {
            const started = yield* turnStartedOf(previous.value.event).pipe(Effect.mapError(storage("session.decode")))
            // The key's fingerprint is the message, the command and the turn resumed, never `meta`: a retry with other metadata is the same turn.
            const same = sameUserMessage(started.userMessage, input.userMessage) && canonicalJson(started.command) === canonicalJson(input.command)
              && started.resumes === input.resumes
            return yield* Effect.fail(same
              ? new TurnDuplicate({ session: address.id, turn: previous.value.turn, open: Option.exists(state.open, (open) => open.turn === previous.value.turn) })
              : new KeyConflict({ session: address.id, key: input.key, turn: previous.value.turn }))
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
        const waiting = input._tag === "Inbox" ? pendingOf(state).map((slot) => slot.id) : []
        if (input._tag === "Inbox" && waiting.length === 0) return yield* Effect.fail(new NothingPending({ session: address.id }))
        const claimed = yield* inboxItems(address.id, waiting)
        const userMessage = input._tag === "User" ? input.userMessage : new UserMessage({ text: claimed.map((item) => item.content).join("\n\n") })
        const turn = state.turns + 1
        const key = input._tag === "User" ? input.key : input.runId
        const open: HeldTurn = {
          turn, runId: input.runId, key, origin: input._tag === "User" ? "user" : "inbox", holder: instance,
          expiresAt: ownership.mode === "lease" ? Option.some(head.now + ownership.ttlMs) : Option.none(),
          process: ownership.mode === "process" ? holder.process : Option.none(),
        }
        const next: SessionsState = {
          ...state,
          turns: turn,
          open: Option.some(open),
          title: Option.orElse(state.title, () => input._tag === "User" && input.userMessage.text.length > 0 ? Option.some(titleOf(input.userMessage.text, config.titleChars)) : Option.none()),
          inbox: state.inbox.map((slot) => waiting.includes(slot.id) ? { ...slot, claimedBy: Option.some(turn) } : slot),
        }
        const starting = yield* turnStartedDraft(turn, {
          runId: input.runId, key, origin: open.origin, userMessage, command: input._tag === "User" ? input.command : {},
          claimed: waiting, entry: EntryId.make(`${input.runId}:0`), at,
          // Written only when given: a turn begun without metadata is stored as before.
          ...(input.meta === undefined ? {} : { meta: input.meta }),
          ...resuming,
        }).pipe(Effect.mapError(storage("session.encode")))
        const admitted: AdmittedTurn = {
          session: address, turn, runId: input.runId, key, origin: open.origin, userMessage,
          command: input._tag === "User" ? input.command : {}, claimed, meta, ...resuming,
        }
        return { drafts: [...reap.drafts, starting], next: Option.some(next), result: { admitted, next } }
      }), (opened) => Ref.set(unowned, Option.some(opened.admitted.turn)))))
      const committed = yield* Option.match(begun.committed, {
        onNone: () => Effect.fail(new SessionLogError({ code: "session.begin", message: "the turn was not committed" })),
        onSome: Effect.succeed,
      })
      const started = yield* Option.match(Option.fromNullishOr(committed.events.at(-1)), {
        onNone: () => Effect.fail(new SessionLogError({ code: "session.begin", message: "the turn's start was not stored" })),
        onSome: Effect.succeed,
      })
      const turn = begun.result.admitted.turn
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
  const normalized = (input: BeginTurn): Effect.Effect<BeginTurn, AttachmentRejected> => input._tag === "User"
    ? normalizeUserMessage(input.userMessage).pipe(Effect.map((userMessage) => ({ ...input, userMessage })))
    : Effect.succeed(input)

  const begin = (address: SessionAddress, input: BeginTurn) => normalized(input).pipe(
    Effect.flatMap((ready) => openTurn(address, ready)),
    Effect.map((open) => open.writer),
  )

  /** Close this instance's writer of a session, if it holds `turn` (or any turn). */
  const closeLocal = (id: string, reason: "cancelled" | "removed", turn: Option.Option<number>) => Ref.get(writers).pipe(Effect.flatMap((all) =>
    Option.match(Option.fromNullishOr(all.get(id)), {
      onNone: () => Effect.void,
      onSome: (open) => Option.match(turn, { onNone: () => true, onSome: (wanted) => wanted === open.turn }) ? open.close(reason) : Effect.void,
    })))

  const drain = <E, R>(address: SessionAddress, run: (writer: TurnWriter) => Effect.Effect<void, E, R>, options?: { readonly maxTurns?: number; readonly meta?: JsonObject }) => {
    const maxTurns = options?.maxTurns ?? 3
    const meta = options?.meta
    /** One inbox turn, if one opens: then whether items still wait after it. */
    const once: Effect.Effect<Option.Option<boolean>, SessionMissing | SessionLogError, R> = Effect.scoped(Effect.gen(function* () {
      const runId = yield* Effect.sync(() => crypto.randomUUID())
      const open = yield* openTurn(address, meta === undefined ? { _tag: "Inbox", runId } : { _tag: "Inbox", runId, meta })
      // A HarnessError carried as a defect keeps its own code, as in `Agent.turn`.
      const exit = yield* Effect.exit(harnessDefectsAsFailures(run(open.writer)))
      // The turn ends with what ended `run`: its error's code, `turn.defect` or `turn.interrupted`.
      const ending = turnEndingOf(Exit.map(exit, () => ({ outcome: "completed" as const })))
      // A drain interrupted from outside stops before this line, so an interruption here is `run`'s own: it counts
      // an attempt even when `run` wrote nothing, so an item whose run keeps interrupting itself is still dropped.
      if (ending.reason === "interrupted") yield* open.markTried
      yield* Option.match(ending.failure, {
        onNone: () => Effect.void,
        onSome: (failure) => Effect.logWarning(`inbox turn ${open.writer.admitted.turn} of ${address.id} ended ${ending.reason}: ${failure.code}`),
      })
      // The drain closes its own turns, so it drains what they leave: its end counts what waits (items delivered
      // during the turn included). An end not stored is logged, and the drain goes on: the scope tries the end
      // again, and lets the turn go when that fails too, so the next begin reaps it and takes its items again.
      return yield* open.writer.end(ending).pipe(
        Effect.map((ended) => Option.some(ended.pending > 0)),
        Effect.catch((error) => (error.code === "turn.closed" ? Effect.logDebug : Effect.logWarning)(`inbox turn ${open.writer.admitted.turn} of ${address.id} did not store its end: ${error.code}: ${error.message}`).pipe(
          Effect.annotateLogs(turnLogIds(address.id, open.writer.admitted.turn)),
          Effect.as(Option.some(true)),
        )),
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
        TurnRefused: (refused) => Effect.logWarning(`inbox turn of ${address.id} refused: ${refused.message}`).pipe(Effect.as(Option.none<boolean>())),
      }),
    )
    const loop = (turns: number): Effect.Effect<{ readonly turns: number }, SessionMissing | SessionLogError, R> =>
      turns >= maxTurns ? Effect.succeed({ turns }) : once.pipe(Effect.flatMap(Option.match({
        onNone: () => Effect.succeed({ turns }),
        onSome: (more) => more ? loop(turns + 1) : Effect.succeed({ turns: turns + 1 }),
      })))
    return loop(0)
  }

  const activity = TurnActivity.of({
    current: SubscriptionRef.get(inFlight).pipe(Effect.map((now) => ({
      open: [...now.held.values()].sort((left, right) => left.since - right.since),
      beginning: now.beginning,
    }))),
    idle: SubscriptionRef.changes(inFlight).pipe(Stream.filter((now) => now.held.size === 0 && now.beginning === 0), Stream.take(1), Stream.runDrain),
  })

  return Context.make(TurnActivity, activity).pipe(Context.add(Sessions, Sessions.of({
    create: (input) => Effect.gen(function* () {
      const head = yield* log.create({
        id: input.id ?? (yield* freshId), owner: input.owner, origin: input.origin ?? "user",
        createdAt: yield* Clock.currentTimeMillis, meta: input.meta ?? {}, parent: Option.none(),
      }).pipe(Effect.catchTag("SessionMissing", (error) => Effect.fail(new SessionLogError({ code: "session.create", message: `no parent ${error.session}` }))))
      return yield* viewFrom(head)
    }),
    fork: (parent, input) => Effect.gen(function* () {
      yield* owned(parent)
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
    }),
    get: (address) => owned(address).pipe(Effect.flatMap(viewFrom)),
    list: (query) => Effect.gen(function* () {
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
    remove: (address) => Effect.gen(function* () {
      yield* owned(address)
      yield* log.remove(address.id)
      yield* Ref.update(released, (all) => new Map([...all].filter(([session]) => session !== address.id)))
      yield* closeLocal(address.id, "removed", Option.none())
      yield* wake(address.id)
    }),
    read: (address, query) => owned(address).pipe(Effect.flatMap(() => log.read(address.id, {
      after: query?.after ?? 0, limit: Option.fromNullishOr(query?.limit), kinds: query?.kinds ?? [],
    }))),
    changes: (address) => Stream.fromPubSub(signals).pipe(Stream.filter((id) => id === address.id), Stream.map(() => undefined)),
    lookup: (address, key) => owned(address).pipe(Effect.flatMap(() => keyed(address.id, key)), Effect.map(Option.map((found) => found.turn))),
    transact: (address, decide) => guarded(address, (head, state) => Effect.gen(function* () {
      const decision = yield* decide(yield* viewOf(head, state, holder))
      const reserved = decision.drafts.find((draft) => RESERVED_KINDS.includes(draft.kind))
      if (reserved !== undefined) return yield* Effect.fail(new ReservedKind({ kind: reserved.kind }))
      return { drafts: standalone(decision.drafts), next: Option.none<SessionsState>(), result: decision.result }
    })).pipe(Effect.map((done) => ({ result: done.result, events: Option.match(done.committed, { onNone: () => [], onSome: (committed) => committed.events }) }))),
    // A turn nobody holds any more is reaped, as by a begin or a delivery, whichever comes first: it is not open, so the
    // cancel cancels nothing, and the outcome (interrupted, its items waiting again) does not depend on the order.
    cancel: (address, turn) => guarded(address, (head, stored) => Effect.gen(function* () {
      const reap = yield* reaped(head, stored)
      const state = reap.state
      if (Option.isSome(reap.closed)) return { drafts: reap.drafts, next: Option.some(state), result: { cancelled: false, pending: pendingOf(state).length } }
      if (!Option.exists(state.open, (open) => open.turn === turn)) return { drafts: [], next: Option.none<SessionsState>(), result: { cancelled: false, pending: pendingOf(state).length } }
      const after = closedState(state, "cancelled", config.inbox.attempts, true)
      const closing = yield* turnEndedDraft(turn, { reason: "cancelled", failure: Option.none() }).pipe(Effect.mapError(storage("session.encode")))
      return { drafts: [closing], next: Option.some(after.state), result: { cancelled: true, pending: pendingOf(after.state).length } }
    })).pipe(Effect.tap((done) => done.result.cancelled ? closeLocal(address.id, "cancelled", Option.some(turn)) : Effect.void), Effect.map((done) => done.result)),
    begin,
    deliver: (address, item) => guarded(address, (head, stored) => Effect.gen(function* () {
      const reap = yield* reaped(head, stored)
      const state = reap.state
      const reapedOnly = { drafts: reap.drafts, next: reap.drafts.length === 0 ? Option.none<SessionsState>() : Option.some(state) }
      if (state.inbox.some((slot) => slot.id === item.id)) return { ...reapedOnly, result: { delivered: false, pending: pendingOf(state).length } }
      const earlier = yield* log.read(address.id, { after: 0, limit: Option.none(), kinds: ["inbox.queued"] })
      if (earlier.some((event) => event.data.id === item.id)) return { ...reapedOnly, result: { delivered: false, pending: pendingOf(state).length } }
      if (pendingOf(state).length >= config.inbox.maxPending) return yield* Effect.fail(new InboxFull({ session: address.id, pending: pendingOf(state).length }))
      const next: SessionsState = { ...state, inbox: [...state.inbox, { id: item.id, attempts: 0, claimedBy: Option.none() }] }
      const queued = yield* queuedData(item).pipe(Effect.mapError(storage("session.encode")))
      return {
        drafts: [...reap.drafts, { kind: "inbox.queued", turn: Option.none(), data: queued }],
        next: Option.some(next),
        result: { delivered: true, pending: pendingOf(next).length },
      }
    })).pipe(Effect.map((done) => done.result)),
    drain,
  })))
}))
