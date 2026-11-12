import { Array as Arr, Effect, Fiber, Option, Ref, Result } from "effect"
import type { Duration, Exit } from "effect"
import {
  announced,
  beginTurn,
  Core,
  definePlugin,
  endTurn,
  headerOf,
  listenerFailed,
  newSession,
  outcomeOf,
  Seq,
  SessionId,
  Sessions,
  sessionStateOf,
  Storage,
  turnEnded,
  turnStarted,
} from "@xandreed/core/kernel"
import type { AnnouncedEvent, OpenSession, SessionRefused, SessionState, StoredDraft, TurnNumber } from "@xandreed/core/kernel"

/**
 * How the session plugin is set up.
 *
 * @public
 */
export interface SessionsOptions {
  /**
   * How long the close of a turn waits for the listeners of
   * `plugin.session.turn.ended` before it stops waiting and cuts them
   * short. 5 seconds when left out.
   */
  readonly closeWait?: Duration.Input
}

type Phases = ReadonlyMap<SessionId, SessionState>
/** A session and its open turn. */
interface Origin {
  readonly id: SessionId
  readonly turn: TurnNumber
}
/** A turn as `begin` opened it: the open session, and its stored start, not announced yet. */
interface Opened {
  readonly session: OpenSession
  readonly started: AnnouncedEvent
}

/**
 * The session plugin: it owns turns and the order of the journal. One turn
 * at a time per session; every event stored through it, then announced on
 * `Core` under the same name; a turn that always closes. A session's phase
 * is folded from its journal the first time this process meets it.
 *
 * @public
 */
export const sessions = (options: SessionsOptions = {}) => definePlugin({
  name: "session",
  version: "0.22.0",
  provides: Sessions,
  make: Effect.gen(function* () {
    const core    = yield* Core
    const storage = yield* Storage
    const scope   = yield* Effect.scope
    const phases  = yield* Ref.make<Phases>(new Map())
    const places  = yield* Ref.make<ReadonlyMap<SessionId, Seq>>(new Map())

    /** The session's phase and its last place, read from storage the first time. */
    const known = Effect.fnUntraced(function* (id: SessionId) {
      if ((yield* Ref.get(phases)).has(id)) return
      const journal = yield* storage.read(id)
      const state = yield* Effect.fromResult(sessionStateOf(journal.events))
      const last = Option.match(Arr.last(journal.events), { onNone: () => Seq.make(0), onSome: (event) => event.seq })
      yield* Ref.update(phases, (all) => all.has(id) ? all : new Map([...all, [id, state]]))
      yield* Ref.update(places, (all) => all.has(id) ? all : new Map([...all, [id, last]]))
    })

    /** Move the session's phase by one transition, or fail with its refusal. */
    const move = <S extends SessionState>(id: SessionId, transition: (state: SessionState) => Result.Result<S, SessionRefused>) =>
      Ref.modify(phases, (all) => Result.match(transition(all.get(id) ?? newSession), {
        onFailure: (refusal): readonly [Effect.Effect<S, SessionRefused>, Phases] => [Effect.fail(refusal), all],
        onSuccess: (next): readonly [Effect.Effect<S, SessionRefused>, Phases] => [Effect.succeed(next), new Map([...all, [id, next]])],
      })).pipe(Effect.flatten)

    /** Put an event at the next place of the session's journal. */
    const store = Effect.fnUntraced(function* (id: SessionId, event: StoredDraft) {
      const last = (yield* Ref.get(places)).get(id) ?? Seq.make(0)
      const stored = yield* storage.append(id, last, event)
      yield* Ref.update(places, (all) => new Map([...all, [id, stored.seq]]))
      return stored
    })

    const append = (session: Origin) => (event: StoredDraft) => Effect.gen(function* () {
      const stored = yield* store(session.id, event)                  // in the journal first
      yield* core.publish(announced(session, stored))                 // then announced, same name
      return stored
    })

    const begin = Effect.fn("kernel.session.begin")(function* (id: SessionId) {
      yield* known(id)
      const { turn } = yield* move(id, beginTurn)                     // Free → TurnOpen, or SessionBusy
      const started = yield* store(id, turnStarted(turn)).pipe(       // a turn that cannot be stored never opened
        Effect.tapError(() => Ref.update(phases, (all) => new Map([...all, [id, { _tag: "Free", turns: turn - 1 }]]))),
      )
      const session: OpenSession = { id, turn, journal: Effect.map(storage.read(id), (journal) => journal.events), append: append({ id, turn }) }
      const opened: Opened = { session, started: announced(session, started) }
      return opened
    })

    /** Announce the end of a turn. No listener can fail it or hold it: a failure, or a listener cut short at `closeWait`, is `core.listener.failed`. */
    const announceEnd = (ended: AnnouncedEvent) => core.publish(ended).pipe(
      Effect.catchTag("ListenerFailed", (failure) => core.publish(listenerFailed(ended, failure)).pipe(
        Effect.ignore({ log: "Warn", message: "a listener of core.listener.failed failed" }),
      )),
      Effect.timeoutOption(options.closeWait ?? "5 seconds"),
    )

    const end = Effect.fn("kernel.session.end")(function* (open: Opened, exit: Exit.Exit<unknown, unknown>) {
      const { id, turn } = open.session
      const ended = yield* Effect.exit(store(id, turnEnded(turn, outcomeOf(exit))))   // in the journal first
      yield* move(id, endTurn)                                        // TurnOpen → Free, whether or not the end was stored
      const stored = yield* ended
      // Announced last, on a fiber of the plugin: the session is free already, and the caller waits for the listeners only while it is not interrupted.
      const delivery = yield* Effect.forkIn(announceEnd(announced(open.session, stored)), scope)
      yield* Effect.interruptible(Fiber.await(delivery))
    })

    return Sessions.of({
      create: (input) => Effect.sync(() => SessionId.make(crypto.randomUUID())).pipe(
        Effect.tap((id) => storage.create(headerOf(id, input))),
      ),
      read: (id) => storage.read(id),
      turn: (id, body) => Effect.acquireUseRelease(
        begin(id),                                                    // Free → TurnOpen, or refused; stores plugin.session.turn.started
        (open) => Effect.andThen(core.publish(open.started), body(open.session)),   // announced inside the turn, so a listener that fails it still closes it
        (open, exit) => end(open, exit),                              // stores plugin.session.turn.ended with the outcome, frees the session, announces it; always runs
      ),
    })
  }),
})
