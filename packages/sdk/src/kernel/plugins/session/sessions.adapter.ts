import { Array as Arr, Effect, Exit, Fiber, Layer, Option, Ref, Schema, Semaphore } from "effect"
import type { Duration } from "effect"
import {
  announced,
  beginTurn,
  Core,
  headerOf,
  InvalidSession,
  KERNEL_READER,
  NewSession,
  outcomeOf,
  Seq,
  SessionId,
  SessionRefused,
  Sessions,
  sessionStateOf,
  JournalStorage,
  turnEnded,
  turnStarted,
} from "@xandreed/core/kernel"
import type { AnnouncedEvent, OpenSession, JournalStorageError, StoredDraft, TurnNumber } from "@xandreed/core/kernel"

/**
 * How the session plugin is set up.
 *
 * @public
 */
export interface SessionsOptions {
  /**
   * How long the close of a turn gives the listeners of
   * `core.session.turn.ended`. The session stays busy while they run and
   * is free when they are done or, at the latest, after this long, when a
   * listener still running is cut short. A turn interrupted as it opened
   * has its start announced there first, with as long again for its
   * listeners. 5 seconds when left out.
   */
  readonly closeWait?: Duration.Input
  /**
   * How a new session's id is minted. A version 4 UUID from the platform's
   * cryptographic random source when left out; a test supplies its own to
   * have ids it can name.
   */
  readonly mintId?: Effect.Effect<SessionId>
}

/**
 * A turn this process opened: where it is, the last place it wrote at,
 * whether it closed, and the lock its writes take one at a time. The place
 * is unknown after a write that did not report success: its store may have
 * kept the event all the same, so the next write reads the place from the
 * store.
 */
interface Turn {
  readonly id: SessionId
  readonly turn: TurnNumber
  readonly place: Ref.Ref<Option.Option<Seq>>
  readonly closed: Ref.Ref<boolean>
  readonly writes: Semaphore.Semaphore
}
/**
 * A turn as `begin` opened it: the open session a body is given, its stored
 * start, not announced yet, and whether the announcement of the start began.
 */
interface Opened {
  readonly turn: Turn
  readonly session: OpenSession
  readonly started: AnnouncedEvent
  readonly announcing: Ref.Ref<boolean>
}

const hex = (byte: number) => byte.toString(16).padStart(2, "0")

/**
 * A version 4 UUID from the platform's cryptographic random source. It is
 * built from `crypto.getRandomValues`, which a browser offers in every
 * context, where `crypto.randomUUID` asks for a secure one.
 */
const mintUuid = Effect.sync(() => {
  const text = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte, index) => hex(index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte))
    .join("")
  return SessionId.make(`${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`)
})

const decodeSession = Schema.decodeUnknownEffect(NewSession)

const busy = (id: SessionId, why: string) => new SessionRefused({ reason: "SessionBusy", message: `session ${id} is busy: ${why}` })

/** Whether a record is named under core's own prefix: core's records are this plugin's to write, never a body's. */
const reserved = (event: StoredDraft) => KERNEL_READER.reads.some((prefix) => event.name.startsWith(prefix))

/**
 * The session plugin: it owns turns and the order of the journal. One turn
 * at a time per session; every event stored through it, then announced on
 * `Core` under the same name; a turn that closes on every exit of its body.
 * The store is the truth: every turn begins from the phase and the last
 * place the journal holds, its first append is its claim on the journal,
 * and a turn whose end cannot be stored stays open, as the journal says.
 *
 * @public
 */
export const sessions = (options: SessionsOptions = {}): Layer.Layer<Sessions, never, Core | JournalStorage> => Layer.effect(Sessions, Effect.gen(function* () {
  const core    = yield* Core
  const storage = yield* JournalStorage
  const scope   = yield* Effect.scope
  /** The sessions with a turn open or closing in this process: the journal cannot say that an end is still being announced. */
  const held    = yield* Ref.make<ReadonlySet<SessionId>>(new Set())

  const claim = (id: SessionId) => Ref.modify(held, (now): readonly [Effect.Effect<void, SessionRefused>, ReadonlySet<SessionId>] => now.has(id)
    ? [Effect.fail(busy(id, "a turn is open, or its end is being announced")), now]
    : [Effect.void, new Set([...now, id])]).pipe(Effect.flatten)
  const release = (id: SessionId) => Ref.update(held, (now) => new Set(Array.from(now).filter((other) => other !== id)))

  /** The place of the last event the store holds for a session: 0 for none. */
  const lastPlace = (id: SessionId) => Effect.map(storage.read(id), (journal) =>
    Option.match(Arr.last(journal.events), { onNone: () => Seq.make(0), onSome: (event) => event.seq }))

  /**
   * Put an event at the next place of the turn's journal. The caller holds the turn's lock: one write at a time. The
   * place is unknown from the moment the store is asked until it reports success: a store interrupted, or one that
   * fails after it kept the event, leaves the next write, the end's included, to read the place from the store.
   */
  const store = Effect.fnUntraced(function* (open: Turn, event: StoredDraft) {
    const place = yield* Option.match(yield* Ref.get(open.place), { onNone: () => lastPlace(open.id), onSome: Effect.succeed })
    yield* Ref.set(open.place, Option.none())
    const stored = yield* storage.append(open.id, place, event)
    yield* Ref.set(open.place, Option.some(stored.seq))
    return stored
  })

  const append = (open: Turn) => (event: StoredDraft) => Effect.gen(function* () {
    if (reserved(event)) return yield* Effect.fail(new SessionRefused({ reason: "ReservedName", message: `${event.name} is core's to write, not a turn's body` }))
    const stored = yield* open.writes.withPermits(1)(Effect.gen(function* () {   // one write at a time, the end's included
      if (yield* Ref.get(open.closed)) return yield* Effect.fail(new SessionRefused({ reason: "NoOpenTurn", message: `turn ${open.turn} of session ${open.id} has closed` }))
      return yield* store(open, event)                              // in the journal first
    }))
    yield* core.publish(announced(open, stored))                    // then announced, same name
    return stored
  })

  const begin = Effect.fn("kernel.session.begin")(function* (id: SessionId) {
    yield* claim(id)                                                // one turn at a time here, until its end was announced
    return yield* Effect.gen(function* () {
      const journal = yield* storage.read(id)                       // the store is the truth: the phase and the last place, read now
      const state = yield* Effect.fromResult(sessionStateOf(journal.events))
      const { turn } = yield* Effect.fromResult(beginTurn(state))   // Free → TurnOpen, or SessionBusy
      const open: Turn = {
        id,
        turn,
        place: yield* Ref.make(Option.some(Option.match(Arr.last(journal.events), { onNone: () => Seq.make(0), onSome: (event) => event.seq }))),
        closed: yield* Ref.make(false),
        writes: yield* Semaphore.make(1),
      }
      // The first append is the claim on the journal: a conflict there is another writer's turn, not a storage failure.
      const started = yield* store(open, turnStarted(turn)).pipe(
        Effect.catchTag("JournalStorageError", (error): Effect.Effect<never, SessionRefused | JournalStorageError> =>
          error.reason === "SeqConflict" ? Effect.fail(busy(id, "another writer opened a turn")) : Effect.fail(error)),
      )
      const session: OpenSession = { id, turn, journal: Effect.map(storage.read(id), (now) => now.events), append: append(open) }
      const opened: Opened = { turn: open, session, started: announced(open, started), announcing: yield* Ref.make(false) }
      return opened
    }).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? release(id) : Effect.void))   // a turn that did not open, for whatever reason, holds nothing
  })

  /**
   * Announce the end of a turn, and free its session. No listener can
   * fail it or hold it past `closeWait`, whether or not it can be
   * interrupted: every listener the announcement waits for hears it, and a
   * failure, or a listener cut short, is `core.listener.failed`. The
   * session is freed after the listeners the announcement waits for and
   * before the end is handed to the background listeners and the host's
   * stream, so whoever hears of the end there finds the session free. A
   * start whose announcement never began, the turn interrupted as it
   * opened, is announced first, so no listener hears an end without its
   * start; it has a `closeWait` of its own, so a listener that holds it
   * cannot keep the end from being announced.
   */
  const announceEnd = (open: Opened, ended: AnnouncedEvent) => Effect.gen(function* () {
    const bounded = (event: AnnouncedEvent, step: Effect.Effect<void>) =>
      Effect.timeoutOption(core.publish(event, { beforeHandOver: step, listenerFailures: "report" }), options.closeWait ?? "5 seconds")
    if (!(yield* Ref.get(open.announcing))) yield* bounded(open.started, Effect.void)
    yield* bounded(ended, release(open.turn.id))
  }).pipe(
    Effect.ensuring(release(open.turn.id)),                         // whatever became of the announcement
  )

  const end = Effect.fn("kernel.session.end")(function* (open: Opened, exit: Exit.Exit<unknown, unknown>) {
    const { id, turn } = open.turn
    yield* Ref.set(open.turn.closed, true)                          // nothing is appended to this turn from here on
    // In the journal first, after a write still under way. A turn whose end cannot be stored stays open, as the journal
    // says it is: the caller gets the failure.
    const ended = yield* open.turn.writes.withPermits(1)(store(open.turn, turnEnded(turn, outcomeOf(exit)))).pipe(
      Effect.onExit((stored) => Exit.isFailure(stored) ? release(id) : Effect.void),
    )
    // Then announced, on a fiber of the plugin, and only then is the session free: the next turn's events reach
    // listeners after this end. The caller waits for the listeners while it is not interrupted; the session, at most `closeWait`.
    const delivery = yield* Effect.forkIn(announceEnd(open, announced(open.turn, ended)), scope, { startImmediately: true })
    yield* Effect.interruptible(Fiber.await(delivery))
  })

  return Sessions.of({
    create: (input) => decodeSession(input).pipe(
      Effect.mapError(() => new InvalidSession({ message: "a session needs an owner that is not empty, and a parent that is a session id" })),
      Effect.flatMap((decoded) => Effect.tap(options.mintId ?? mintUuid, (id) => storage.create(headerOf(id, decoded)))),
    ),
    read: (id) => storage.read(id),
    turn: (id, body) => Effect.acquireUseRelease(
      begin(id),                                                    // Free → TurnOpen, or refused; stores core.session.turn.started
      (open) => Effect.andThen(                                     // announced inside the turn, so a listener that fails it still closes it
        core.publish(open.started, { beforeHandOver: Ref.set(open.announcing, true) }),   // marked once handed over; the end announces a start never announced
        body(open.session),
      ),
      (open, exit) => end(open, exit),                              // stores core.session.turn.ended with the outcome, announces it, frees the session; always runs
    ),
  })
}))
