import { Clock, Effect, Exit, Layer, Option, PubSub, Ref, Scope, Stream } from "effect"
import {
  canonicalJson,
  ConversationId,
  EntryId,
  InboxFull,
  KeyConflict,
  NothingPending,
  RESERVED_KINDS,
  ReservedKind,
  SessionBusy,
  SessionLog,
  SessionLogError,
  SessionMissing,
  Sessions,
  TurnAdmission,
  TurnDuplicate,
  turnEndedDraft,
  turnStartedDraft,
  turnStartedOf,
  UserMessage,
} from "@xandreed/core"
import type {
  AdmittedTurn,
  BeginTurn,
  InboxItem,
  OpenTurn,
  SessionAddress,
  SessionCommitted,
  SessionDraft,
  SessionHead,
  SessionLogEvent,
  TurnDraft,
  TurnWriter,
} from "@xandreed/core"
import { closedState, heldTurn, pendingOf, stateJson, stateOf, titleOf, viewOf } from "./sessions-state.entity.functions.js"
import type { SessionsConfig, SessionsState } from "./sessions-state.entity.js"
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

const standalone = (drafts: ReadonlyArray<TurnDraft>): ReadonlyArray<SessionDraft> =>
  drafts.map((draft) => ({ kind: draft.kind, turn: Option.none(), data: draft.data }))

/**
 * Sessions over a SessionLog. The state (turns, the open turn, the title,
 * the inbox) is kept in the head and changed only by guarded commits, with
 * the events that justify it, so every instance over the same log agrees.
 * Turns are written by their `TurnWriter`; everything else here is one
 * compare-and-swap loop that plans again after a conflict.
 */
export const SessionsLive = (config: SessionsConfig): Layer.Layer<Sessions, never, SessionLog | TurnAdmission> => Layer.effect(Sessions, Effect.gen(function* () {
  const log = yield* SessionLog
  const admission = yield* TurnAdmission
  const ownership = config.ownership
  const instance = yield* Effect.sync(() => crypto.randomUUID())
  const signals = yield* PubSub.unbounded<string>()
  const writers = yield* Ref.make(new Map<string, OpenWriter & { readonly turn: number }>())
  const wake = (id: string) => PubSub.publish(signals, id).pipe(Effect.asVoid)
  const freshId = Effect.sync(() => ConversationId.make(crypto.randomUUID()))

  const stateFrom = (head: SessionHead) => stateOf(head).pipe(Effect.mapError(storage("session.state")))
  const owned = (address: SessionAddress) => log.head(address.id).pipe(Effect.flatMap((head) =>
    head.header.owner === address.owner ? Effect.succeed(head) : Effect.fail(new SessionMissing({ session: address.id }))))
  const viewFrom = (head: SessionHead) => stateFrom(head).pipe(Effect.map((state) => viewOf(head, state, ownership, instance)))

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
      const outcome = yield* Effect.uninterruptible(Effect.result(log.commit(address.id, {
        expect: head.revision, notAfter: Option.none(), events: planned.drafts, state: Option.map(planned.next, stateJson),
      })).pipe(Effect.tap((result) => result._tag === "Success" ? stored(planned.result) : Effect.void)))
      if (outcome._tag === "Success") {
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

  /** An open turn nobody holds any more (its lease ran out, or its process is gone) is closed as interrupted. */
  const reaped = (head: SessionHead, state: SessionsState) => Effect.gen(function* () {
    if (Option.isNone(state.open) || Option.isSome(heldTurn(head, state, ownership, instance))) return { drafts: [] as ReadonlyArray<SessionDraft>, state }
    const turn = state.open.value.turn
    const after = closedState(state, "interrupted", config.inbox.attempts)
    const closing = yield* turnEndedDraft(turn, { reason: "interrupted", failure: Option.some({ code: "turn.lease", message: "the turn's holder stopped writing" }) })
      .pipe(Effect.mapError(storage("session.encode")))
    const dropped = after.dropped.map((id): SessionDraft => ({ kind: "inbox.dropped", turn: Option.some(turn), data: { id, reason: "attempts" } }))
    return { drafts: [closing, ...dropped], state: after.state }
  })

  /** The turn begun with `key`, and what it was begun with. */
  const keyed = (id: ConversationId, key: string) => log.read(id, { after: 0, limit: Option.none(), kinds: ["turn.started"] }).pipe(
    Effect.flatMap((events) => Option.match(Option.fromNullishOr(events.find((event) => event.data.key === key)), {
      onNone: () => Effect.succeed(Option.none<{ readonly turn: number; readonly event: SessionLogEvent }>()),
      onSome: (event) => Effect.succeed(Option.some({ turn: Option.getOrElse(event.turn, () => 0), event })),
    })),
  )

  /** The inbox items with these ids, as delivered. */
  const inboxItems = (id: ConversationId, ids: ReadonlyArray<string>) => log.read(id, { after: 0, limit: Option.none(), kinds: ["inbox.queued"] }).pipe(
    Effect.map((events) => ids.flatMap((wanted): ReadonlyArray<InboxItem> => Option.toArray(Option.fromNullishOr(events.find((event) => event.data.id === wanted))).map((event) => ({
      id: wanted,
      source: typeof event.data.source === "object" && event.data.source !== null ? event.data.source as Record<string, unknown> : {},
      content: typeof event.data.content === "string" && event.data.content.length > 0 ? event.data.content : `(inbox item ${wanted})`,
    })))),
  )

  /** Close a turn this instance opened whose begin never handed it to a writer (interrupted after its commit). */
  const unhanded = (address: SessionAddress, turn: number, exit: Exit.Exit<unknown, unknown>) => guarded(address, (_head, state) => Effect.gen(function* () {
    if (!Option.exists(state.open, (open) => open.turn === turn && open.holder === instance)) return { drafts: [], next: Option.none<SessionsState>(), result: undefined }
    const reason = Exit.hasInterrupts(exit) ? "interrupted" as const : "failed" as const
    const after = closedState(state, reason, config.inbox.attempts)
    const closing = yield* turnEndedDraft(turn, { reason, failure: Option.some({ code: "turn.unended", message: "the turn's scope closed before it ended" }) })
      .pipe(Effect.mapError(storage("session.encode")))
    const dropped = after.dropped.map((id): SessionDraft => ({ kind: "inbox.dropped", turn: Option.some(turn), data: { id, reason: "attempts" } }))
    return { drafts: [closing, ...dropped], next: Option.some(after.state), result: undefined }
  })).pipe(Effect.timeout("10 seconds"), Effect.ignore)

  /**
   * Open a turn. Everything after the opening commit runs uninterruptibly
   * until the writer (and its finalizer) exists; what may wait — the host's
   * admission, the reads — stays interruptible, and a turn committed under
   * an admission that is then interrupted is closed by the scope.
   */
  const begin = (address: SessionAddress, input: BeginTurn) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const scope = yield* Effect.scope
    const at = yield* Clock.currentTimeMillis
    const toAdmit = { session: address, origin: input._tag === "User" ? "user" as const : "inbox" as const, runId: input.runId, key: input._tag === "User" ? input.key : input.runId }
    const unowned = yield* Ref.make(Option.none<number>())
    yield* Scope.addFinalizerExit(scope, (exit) => Ref.get(unowned).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (turn) => unhanded(address, turn, exit) }))))
    // Only the opening commit is admitted: the writer's later commits run outside the host's admission.
    const begun = yield* restore(admission.admit(toAdmit, guarded(address, (head, stored) => Effect.gen(function* () {
      const reap = yield* reaped(head, stored)
      const state = reap.state
      if (input._tag === "User") {
        const previous = yield* keyed(address.id, input.key)
        if (Option.isSome(previous)) {
          const started = yield* turnStartedOf(previous.value.event).pipe(Effect.mapError(storage("session.decode")))
          const same = started.userMessage.text === input.userMessage.text && canonicalJson(started.command) === canonicalJson(input.command)
          return yield* Effect.fail(same
            ? new TurnDuplicate({ session: address.id, turn: previous.value.turn, open: Option.exists(state.open, (open) => open.turn === previous.value.turn) })
            : new KeyConflict({ session: address.id, key: input.key, turn: previous.value.turn }))
        }
      }
      if (Option.isSome(state.open)) return yield* Effect.fail(new SessionBusy({ session: address.id, turn: state.open.value.turn }))
      const waiting = input._tag === "Inbox" ? pendingOf(state).map((slot) => slot.id) : []
      if (input._tag === "Inbox" && waiting.length === 0) return yield* Effect.fail(new NothingPending({ session: address.id }))
      const claimed = yield* inboxItems(address.id, waiting)
      const userMessage = input._tag === "User" ? input.userMessage : new UserMessage({ text: claimed.map((item) => item.content).join("\n\n") })
      const turn = state.turns + 1
      const key = input._tag === "User" ? input.key : input.runId
      const open: OpenTurn = {
        turn, runId: input.runId, key, origin: input._tag === "User" ? "user" : "inbox", holder: instance,
        expiresAt: ownership.mode === "lease" ? Option.some(head.now + ownership.ttlMs) : Option.none(),
      }
      const next: SessionsState = {
        ...state,
        turns: turn,
        open: Option.some(open),
        title: Option.orElse(state.title, () => input._tag === "User" ? Option.some(titleOf(input.userMessage.text, config.titleChars)) : Option.none()),
        inbox: state.inbox.map((slot) => waiting.includes(slot.id) ? { ...slot, claimedBy: Option.some(turn) } : slot),
      }
      const starting = yield* turnStartedDraft(turn, {
        runId: input.runId, key, origin: open.origin, userMessage, command: input._tag === "User" ? input.command : {},
        claimed: waiting, entry: EntryId.make(`${input.runId}:0`), at,
      }).pipe(Effect.mapError(storage("session.encode")))
      const admitted: AdmittedTurn = {
        session: address, turn, runId: input.runId, key, origin: open.origin, userMessage,
        command: input._tag === "User" ? input.command : {}, claimed,
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
    yield* Effect.addFinalizer(() => Ref.update(writers, (all) => new Map([...all].filter(([id, open]) => id !== address.id || open.turn !== begun.result.admitted.turn))))
    const open = yield* makeTurnWriter({
      log, config, instance, header: begun.head.header, admitted: begun.result.admitted, started,
      position: { revision: committed.revision, seq: committed.seq, state: begun.result.next, storageAt: committed.at },
      wake: wake(address.id),
    }, scope)
    yield* Ref.set(unowned, Option.none())
    yield* Ref.update(writers, (all) => new Map([...all, [address.id, { ...open, turn: begun.result.admitted.turn }]]))
    return open.writer
  }))

  /** Close this instance's writer of a session, if it holds `turn` (or any turn). */
  const closeLocal = (id: string, reason: "cancelled" | "removed", turn: Option.Option<number>) => Ref.get(writers).pipe(Effect.flatMap((all) =>
    Option.match(Option.fromNullishOr(all.get(id)), {
      onNone: () => Effect.void,
      onSome: (open) => Option.match(turn, { onNone: () => true, onSome: (wanted) => wanted === open.turn }) ? open.close(reason) : Effect.void,
    })))

  const drain = <E, R>(address: SessionAddress, run: (writer: TurnWriter) => Effect.Effect<void, E, R>, options?: { readonly maxTurns?: number }) => {
    const maxTurns = options?.maxTurns ?? 3
    const once: Effect.Effect<boolean, SessionMissing | SessionLogError, R> = Effect.scoped(Effect.gen(function* () {
      const writer = yield* begin(address, { _tag: "Inbox", runId: yield* Effect.sync(() => crypto.randomUUID()) })
      const exit = yield* Effect.exit(run(writer))
      if (exit._tag === "Failure") yield* Effect.logWarning(`inbox turn ${writer.admitted.turn} of ${address.id} failed`)
      yield* writer.end({
        reason: exit._tag === "Success" ? "completed" : "failed",
        failure: exit._tag === "Success" ? Option.none() : Option.some({ code: "inbox.turn", message: "the inbox turn failed" }),
      }).pipe(Effect.ignore)
      return true
    })).pipe(
      Effect.catchTags({
        NothingPending: () => Effect.succeed(false),
        SessionBusy: () => Effect.succeed(false),
        TurnDuplicate: () => Effect.succeed(false),
        KeyConflict: () => Effect.succeed(false),
        TurnRefused: (refused) => Effect.logWarning(`inbox turn of ${address.id} refused: ${refused.message}`).pipe(Effect.as(false)),
      }),
    )
    const loop = (turns: number): Effect.Effect<{ readonly turns: number }, SessionMissing | SessionLogError, R> =>
      turns >= maxTurns ? Effect.succeed({ turns }) : once.pipe(Effect.flatMap((ran) => ran ? loop(turns + 1) : Effect.succeed({ turns })))
    return loop(0)
  }

  return Sessions.of({
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
      const sessions = yield* Effect.forEach(heads, viewFrom)
      const last = Option.fromNullishOr(heads.at(-1))
      return {
        sessions,
        next: heads.length < limit ? Option.none() : Option.map(last, (head) => ({ updatedAt: head.updatedAt, id: head.header.id })),
      }
    }),
    remove: (address) => Effect.gen(function* () {
      yield* owned(address)
      yield* log.remove(address.id)
      yield* closeLocal(address.id, "removed", Option.none())
      yield* wake(address.id)
    }),
    read: (address, query) => owned(address).pipe(Effect.flatMap(() => log.read(address.id, {
      after: query?.after ?? 0, limit: Option.fromNullishOr(query?.limit), kinds: query?.kinds ?? [],
    }))),
    changes: (address) => Stream.fromPubSub(signals).pipe(Stream.filter((id) => id === address.id), Stream.map(() => undefined)),
    lookup: (address, key) => owned(address).pipe(Effect.flatMap(() => keyed(address.id, key)), Effect.map(Option.map((found) => found.turn))),
    transact: (address, decide) => guarded(address, (head, state) => Effect.gen(function* () {
      const decision = yield* decide(viewOf(head, state, ownership, instance))
      const reserved = decision.drafts.find((draft) => RESERVED_KINDS.includes(draft.kind))
      if (reserved !== undefined) return yield* Effect.fail(new ReservedKind({ kind: reserved.kind }))
      return { drafts: standalone(decision.drafts), next: Option.none<SessionsState>(), result: decision.result }
    })).pipe(Effect.map((done) => ({ result: done.result, events: Option.match(done.committed, { onNone: () => [], onSome: (committed) => committed.events }) }))),
    cancel: (address, turn) => guarded(address, (_head, state) => Effect.gen(function* () {
      if (!Option.exists(state.open, (open) => open.turn === turn)) return { drafts: [], next: Option.none<SessionsState>(), result: { cancelled: false, pending: pendingOf(state).length } }
      const after = closedState(state, "cancelled", config.inbox.attempts)
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
      return {
        drafts: [...reap.drafts, { kind: "inbox.queued", turn: Option.none(), data: { id: item.id, source: item.source, content: item.content } }],
        next: Option.some(next),
        result: { delivered: true, pending: pendingOf(next).length },
      }
    })).pipe(Effect.map((done) => done.result)),
    drain,
  })
}))
