import { Deferred, Effect, Fiber, Option, Ref, Schema } from "effect"
import type { Context, Scope } from "effect"
import { expect, refuses, show, unexpected } from "./conformance.entity.functions.js"
import type { ConformanceCheck } from "./conformance.entity.js"
import { makeCore } from "./core.adapter.js"
import type { Core } from "./core.port.js"
import { dataOf, stored, storedEvent } from "./event.entity.functions.js"
import type { EventDefinition, KernelEvent } from "./event.entity.js"
import { Owner, SessionId } from "./ids.entity.js"
import type { Sessions } from "./sessions.port.js"
import { listenerFailedEvent, turnEndedEvent, turnStartedEvent } from "./vocabulary.entity.js"

type CoreShape = Context.Service.Shape<typeof Core>
type SessionsShape = Context.Service.Shape<typeof Sessions>

/**
 * A session plugin as the kit opens it: a fresh one per check, over an
 * empty store of its own and the `Core` the kit hands it, released with
 * its scope.
 *
 * @public
 */
export interface SessionsSubject {
  readonly open: (core: CoreShape) => Effect.Effect<SessionsShape, never, Scope.Scope>
}

const owner = Owner.make("kit-owner")

/** The kit's own record: any plugin's event, as far as a session plugin knows. */
const noted = storedEvent("kit", "noted", { data: Schema.Struct({ text: Schema.String }), skippable: true })
const note = (text: string) => stored(noted, { text })

/** What a body fails with in the checks of a failing turn. */
class KitFailure extends Schema.TaggedError<KitFailure>()("KitFailure", { message: Schema.String }) {}

const STARTED = turnStartedEvent.name
const ENDED = turnEndedEvent.name
const watched: ReadonlyArray<EventDefinition<Schema.Json>> = [turnStartedEvent, noted, turnEndedEvent, listenerFailedEvent]

/**
 * The sessions contract as checks, each over a fresh session plugin: a
 * created session reads back empty, and two creations give two ids
 * (`create`); a turn stores `plugin.session.turn.started`, what its body
 * appends and `plugin.session.turn.ended`, at consecutive places, its body
 * reading what it appended, and the next turn is numbered after it
 * (`turn`); every stored event is announced on `Core` after it is in the
 * journal, under the same name, with its session and turn (`announce`); a
 * turn asked for while one is open is refused and stores nothing (`busy`);
 * a body that fails still closes the turn, with the failure as its outcome
 * and the caller's own error, and the next turn runs (`closes`); so does a
 * body that is interrupted (`interrupt`); a waiting listener that fails on
 * an appended event fails the append after the event is stored, and the
 * turn closes (`listener`); a listener that fails on the turn's end fails
 * nothing, leaves the session free and is reported as
 * `core.listener.failed` (`close-listener`); a session never created is
 * refused before any body runs (`missing`).
 *
 * @public
 */
export const sessionsConformance = (subject: SessionsSubject): ReadonlyArray<ConformanceCheck> => {
  /** One check over a fresh `Core` and session plugin, with every watched event as the kit's waiting listener saw it. */
  const check = (
    name: string,
    id: string,
    body: (parts: { readonly core: CoreShape; readonly sessions: SessionsShape; readonly seen: Effect.Effect<ReadonlyArray<KernelEvent>> }) => Effect.Effect<void, { readonly _tag: string; readonly message: string }, Scope.Scope>,
  ): ConformanceCheck => ({
    name,
    run: Effect.scoped(Effect.gen(function* () {
      const core = yield* makeCore()
      const seen = yield* Ref.make<ReadonlyArray<KernelEvent>>([])
      const sessions = yield* subject.open(core)
      yield* Effect.forEach(watched, (definition) =>
        core.on(definition, (event) => Ref.update(seen, (all) => [...all, event]), { wait: true, name: "kit-watch" }), { concurrency: 1, discard: true })
      yield* body({ core, sessions, seen: Ref.get(seen) })
    })).pipe(unexpected(id)),
  })
  const names = (events: ReadonlyArray<{ readonly name: string }>) => events.map((event) => event.name)
  const outcomeOf = (event: Option.Option<{ readonly name: KernelEvent["name"]; readonly data: Schema.Json }>) =>
    Option.match(Option.flatMap(event, (ended) => dataOf(turnEndedEvent, ended)), { onNone: () => "none", onSome: (data) => data.outcome._tag })

  return [
    check("a created session reads back empty, and two creations give two ids", "create", ({ sessions }) => Effect.gen(function* () {
      const first = yield* sessions.create({ owner })
      const second = yield* sessions.create({ owner, parent: first })
      yield* expect("create", first !== second, `two sessions were created with the id ${first}`)
      const journal = yield* sessions.read(first)
      yield* expect("create", journal.header.id === first && journal.header.owner === owner && journal.events.length === 0, `a new session read back as ${show(journal)}`)
      const child = yield* sessions.read(second)
      yield* expect("create", child.header.parent === first, `a session created with a parent read back as ${show(child.header)}`)
    })),
    check("a turn stores its start, what its body appends and its end, in order", "turn", ({ sessions }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      const value = yield* sessions.turn(id, (session) => Effect.gen(function* () {
        const first = yield* session.append(note("one"))
        const inside = yield* session.journal
        yield* expect("turn", session.turn === 1 && first.seq === 2 && show(names(inside)) === show([STARTED, noted.name]),
          `in its first turn (${session.turn}) a body that appended at ${first.seq} read ${show(names(inside))}`)
        yield* session.append(note("two"))
        return "done"
      }))
      yield* expect("turn", value === "done", `the turn returned ${show(value)}, not its body's value`)
      const journal = yield* sessions.read(id)
      yield* expect("turn", show(names(journal.events)) === show([STARTED, noted.name, noted.name, ENDED]), `one turn stored ${show(names(journal.events))}`)
      yield* expect("turn", show(journal.events.map((event) => event.seq)) === show([1, 2, 3, 4]), `one turn stored at ${show(journal.events.map((event) => event.seq))}`)
      yield* expect("turn", show(journal.events[0]?.data) === show({ turn: 1 }) && show(journal.events[3]?.data) === show({ turn: 1, outcome: { _tag: "Completed" } }),
        `the turn's start and end hold ${show(journal.events[0]?.data)} and ${show(journal.events[3]?.data)}`)
      const second = yield* sessions.turn(id, (session) => Effect.succeed(session.turn))
      const after = yield* sessions.read(id)
      yield* expect("turn", second === 2 && show(after.events.map((event) => event.seq)) === show([1, 2, 3, 4, 5, 6]), `the next turn was ${second}, stored at ${show(after.events.map((event) => event.seq))}`)
    })),
    check("every stored event is announced after it is stored, under the same name", "announce", ({ core, sessions, seen }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      const storedFirst = yield* Ref.make<ReadonlyArray<boolean>>([])
      yield* core.on(noted, (event) => Effect.flatMap(sessions.read(id), (journal) =>
        Ref.update(storedFirst, (all) => [...all, event._tag === "Stored" && journal.events.some((kept) => kept.seq === event.seq && kept.name === event.name)])), { wait: true, name: "kit-order" })
      yield* sessions.turn(id, (session) => session.append(note("one")))
      const announced = yield* seen
      yield* expect("announce", show(names(announced)) === show([STARTED, noted.name, ENDED]), `one turn announced ${show(names(announced))}`)
      yield* expect("announce", announced.every((event) => event._tag === "Stored" && event.session === id && event.turn === 1),
        `the announced events were ${show(announced.map((event) => [event._tag, event.session, event.turn]))}`)
      const journal = yield* sessions.read(id)
      yield* expect("announce", show(announced.map((event) => event._tag === "Stored" ? event.seq : 0)) === show(journal.events.map((event) => event.seq)),
        `the announced places were ${show(announced)}, the stored ones ${show(journal.events.map((event) => event.seq))}`)
      yield* expect("announce", show(yield* Ref.get(storedFirst)) === show([true]), "an event was announced before the journal held it")
    })),
    check("a turn asked for while one is open is refused and stores nothing", "busy", ({ sessions }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      const ran = yield* Ref.make(false)
      yield* sessions.turn(id, () => refuses("busy", "a second turn inside an open one", sessions.turn(id, () => Ref.set(ran, true)),
        (error) => error._tag === "SessionRefused" && error.reason === "SessionBusy"))
      yield* expect("busy", !(yield* Ref.get(ran)), "the body of a refused turn ran")
      const journal = yield* sessions.read(id)
      yield* expect("busy", show(names(journal.events)) === show([STARTED, ENDED]), `a refused turn left the journal as ${show(names(journal.events))}`)
    })),
    check("a body that fails still closes the turn, and the next turn runs", "closes", ({ sessions }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      yield* refuses("closes", "a turn whose body failed", sessions.turn(id, () => Effect.fail(new KitFailure({ message: "the body failed" }))), (error) => error._tag === "KitFailure")
      const journal = yield* sessions.read(id)
      const ended = Option.fromNullishOr(journal.events.at(-1))
      yield* expect("closes", show(names(journal.events)) === show([STARTED, ENDED]) && outcomeOf(ended) === "Failed", `a failed turn left ${show(journal.events)}`)
      yield* expect("closes", show(journal.events.at(-1)?.data).includes("KitFailure"), `the outcome of a failed turn is ${show(journal.events.at(-1)?.data)}, without the failure's tag`)
      const next = yield* sessions.turn(id, (session) => Effect.succeed(session.turn))
      yield* expect("closes", next === 2, `the turn after a failed one was ${next}`)
    })),
    check("a body that is interrupted still closes the turn, and the next turn runs", "interrupt", ({ sessions }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      const running = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(sessions.turn(id, () => Effect.andThen(Deferred.succeed(running, undefined), Effect.never)))
      yield* Deferred.await(running)
      yield* Fiber.interrupt(fiber)
      const journal = yield* sessions.read(id)
      yield* expect("interrupt", show(names(journal.events)) === show([STARTED, ENDED]) && outcomeOf(Option.fromNullishOr(journal.events.at(-1))) === "Interrupted",
        `an interrupted turn left ${show(journal.events)}`)
      const next = yield* sessions.turn(id, (session) => Effect.succeed(session.turn))
      yield* expect("interrupt", next === 2, `the turn after an interrupted one was ${next}`)
    })),
    check("a waiting listener that fails on an appended event fails the append, and the turn closes", "listener", ({ core, sessions }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      yield* core.on(noted, () => Effect.fail(new KitFailure({ message: "the listener failed" })), { wait: true, name: "kit-failing" })
      yield* refuses("listener", "a turn whose append a waiting listener failed", sessions.turn(id, (session) => session.append(note("one"))),
        (error) => error._tag === "ListenerFailed" && error.listener === "kit-failing" && error.event === noted.name)
      const journal = yield* sessions.read(id)
      yield* expect("listener", show(names(journal.events)) === show([STARTED, noted.name, ENDED]) && outcomeOf(Option.fromNullishOr(journal.events.at(-1))) === "Failed",
        `a turn failed by a listener left ${show(journal.events)}`)
      const next = yield* sessions.turn(id, (session) => Effect.succeed(session.turn))
      yield* expect("listener", next === 2, `the turn after one a listener failed was ${next}`)
    })),
    check("a listener that fails on the turn's end fails nothing and is reported", "close-listener", ({ core, sessions, seen }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      yield* core.on(turnEndedEvent, () => Effect.fail(new KitFailure({ message: "the listener failed" })), { wait: true, name: "kit-failing" })
      const value = yield* sessions.turn(id, () => Effect.succeed("done"))
      yield* expect("close-listener", value === "done", `a turn whose end a listener failed returned ${show(value)}`)
      const reported = (yield* seen).flatMap((event) => Option.toArray(dataOf(listenerFailedEvent, event)))
      yield* expect("close-listener", reported.some((failure) => failure.listener === "kit-failing" && failure.event === ENDED), `the failure was reported as ${show(reported)}`)
      const next = yield* sessions.turn(id, (session) => Effect.succeed(session.turn))
      yield* expect("close-listener", next === 2, `the turn after one whose end a listener failed was ${next}`)
    })),
    check("a session never created is refused before any body runs", "missing", ({ sessions }) => Effect.gen(function* () {
      const ran = yield* Ref.make(false)
      yield* refuses("missing", "a turn of a session never created", sessions.turn(SessionId.make("kit-stranger"), () => Ref.set(ran, true)),
        (error) => error._tag === "StorageError" && error.reason === "SessionMissing")
      yield* refuses("missing", "a read of a session never created", sessions.read(SessionId.make("kit-stranger")), (error) => error.reason === "SessionMissing")
      yield* expect("missing", !(yield* Ref.get(ran)), "the body of a turn of a missing session ran")
    })),
  ]
}
