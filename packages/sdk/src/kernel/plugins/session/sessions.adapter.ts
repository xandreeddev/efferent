import { Array as Arr, Effect, Exit, Fiber, Option, Ref } from "effect"
import type { Duration } from "effect"
import {
  announced,
  beginTurn,
  Core,
  definePlugin,
  headerOf,
  listenerFailed,
  outcomeOf,
  Seq,
  SessionId,
  SessionRefused,
  Sessions,
  sessionStateOf,
  Storage,
  turnEnded,
  turnStarted,
} from "@xandreed/core/kernel"
import type { AnnouncedEvent, OpenSession, StorageError, StoredDraft, TurnNumber } from "@xandreed/core/kernel"

/**
 * How the session plugin is set up.
 *
 * @public
 */
export interface SessionsOptions {
  /**
   * How long the close of a turn gives the listeners of
   * `plugin.session.turn.ended`. The session stays busy while they run and
   * is free when they are done or, at the latest, after this long, when a
   * listener still running is cut short. 5 seconds when left out.
   */
  readonly closeWait?: Duration.Input
  /**
   * How a new session's id is minted. A version 4 UUID from the platform's
   * cryptographic random source when left out; a test supplies its own to
   * have ids it can name.
   */
  readonly mintId?: Effect.Effect<SessionId>
}

/** A turn this process opened: where it is, the last place it wrote at, and whether it closed. */
interface Turn {
  readonly id: SessionId
  readonly turn: TurnNumber
  readonly place: Ref.Ref<Seq>
  readonly closed: Ref.Ref<boolean>
}
/** A turn as `begin` opened it: the open session a body is given, and its stored start, not announced yet. */
interface Opened {
  readonly turn: Turn
  readonly session: OpenSession
  readonly started: AnnouncedEvent
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

const busy = (id: SessionId, why: string) => new SessionRefused({ reason: "SessionBusy", message: `session ${id} is busy: ${why}` })

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
export const sessions = (options: SessionsOptions = {}) => definePlugin({
  name: "session",
  version: "0.22.0",
  requires: [Core, Storage],
  provides: Sessions,
  make: Effect.gen(function* () {
    const core    = yield* Core
    const storage = yield* Storage
    const scope   = yield* Effect.scope
    /** The sessions with a turn open or closing in this process: the journal cannot say that an end is still being announced. */
    const held    = yield* Ref.make<ReadonlySet<SessionId>>(new Set())

    const claim = (id: SessionId) => Ref.modify(held, (now): readonly [Effect.Effect<void, SessionRefused>, ReadonlySet<SessionId>] => now.has(id)
      ? [Effect.fail(busy(id, "a turn is open, or its end is being announced")), now]
      : [Effect.void, new Set([...now, id])]).pipe(Effect.flatten)
    const release = (id: SessionId) => Ref.update(held, (now) => new Set(Array.from(now).filter((other) => other !== id)))

    /** Put an event at the next place of the turn's journal. */
    const store = Effect.fnUntraced(function* (open: Turn, event: StoredDraft) {
      const stored = yield* storage.append(open.id, yield* Ref.get(open.place), event)
      yield* Ref.set(open.place, stored.seq)
      return stored
    })

    const append = (open: Turn) => (event: StoredDraft) => Effect.gen(function* () {
      if (yield* Ref.get(open.closed)) return yield* Effect.fail(new SessionRefused({ reason: "NoOpenTurn", message: `turn ${open.turn} of session ${open.id} has closed` }))
      const stored = yield* store(open, event)                        // in the journal first
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
          place: yield* Ref.make(Option.match(Arr.last(journal.events), { onNone: () => Seq.make(0), onSome: (event) => event.seq })),
          closed: yield* Ref.make(false),
        }
        // The first append is the claim on the journal: a conflict there is another writer's turn, not a storage failure.
        const started = yield* store(open, turnStarted(turn)).pipe(
          Effect.catchTag("StorageError", (error): Effect.Effect<never, SessionRefused | StorageError> =>
            error.reason === "SeqConflict" ? Effect.fail(busy(id, "another writer opened a turn")) : Effect.fail(error)),
        )
        const session: OpenSession = { id, turn, journal: Effect.map(storage.read(id), (now) => now.events), append: append(open) }
        const opened: Opened = { turn: open, session, started: announced(open, started) }
        return opened
      }).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? release(id) : Effect.void))   // a turn that did not open, for whatever reason, holds nothing
    })

    /**
     * Announce the end of a turn, and free its session. No listener can
     * fail it or hold it past `closeWait`, whether or not it can be
     * interrupted: a failure, or a listener cut short, is
     * `core.listener.failed`. The session is freed after the listeners the
     * announcement waits for and before the end is handed to the background
     * listeners and the host's stream, so whoever hears of the end there
     * finds the session free.
     */
    const announceEnd = (id: SessionId, ended: AnnouncedEvent) => core.publish(ended, { beforeHandOver: release(id) }).pipe(
      Effect.catchTag("ListenerFailed", (failure) => core.publish(listenerFailed(ended, failure)).pipe(
        Effect.ignore({ log: "Warn", message: "the report of a failed listener could not be published" }),
      )),
      Effect.ensuring(release(id)),                                   // whatever became of the announcement
      Effect.timeoutOption(options.closeWait ?? "5 seconds"),
    )

    const end = Effect.fn("kernel.session.end")(function* (open: Opened, exit: Exit.Exit<unknown, unknown>) {
      const { id, turn } = open.turn
      yield* Ref.set(open.turn.closed, true)                          // nothing is appended to this turn from here on
      // In the journal first. A turn whose end cannot be stored stays open, as the journal says it is: the caller gets the failure.
      const ended = yield* store(open.turn, turnEnded(turn, outcomeOf(exit))).pipe(
        Effect.onExit((stored) => Exit.isFailure(stored) ? release(id) : Effect.void),
      )
      // Then announced, on a fiber of the plugin, and only then is the session free: its events reach listeners in
      // journal order. The caller waits for the listeners while it is not interrupted; the session, at most `closeWait`.
      const delivery = yield* Effect.forkIn(announceEnd(id, announced(open.turn, ended)), scope, { startImmediately: true })
      yield* Effect.interruptible(Fiber.await(delivery))
    })

    return Sessions.of({
      create: (input) => Effect.tap(options.mintId ?? mintUuid, (id) => storage.create(headerOf(id, input))),
      read: (id) => storage.read(id),
      turn: (id, body) => Effect.acquireUseRelease(
        begin(id),                                                    // Free → TurnOpen, or refused; stores plugin.session.turn.started
        (open) => Effect.andThen(core.publish(open.started), body(open.session)),   // announced inside the turn, so a listener that fails it still closes it
        (open, exit) => end(open, exit),                              // stores plugin.session.turn.ended with the outcome, announces it, frees the session; always runs
      ),
    })
  }),
})
