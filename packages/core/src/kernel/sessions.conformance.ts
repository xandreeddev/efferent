import { Array as Arr, Deferred, Effect, Fiber, Option, Ref, Schema, Stream } from "effect"
import type { Context, Scope } from "effect"
import { expect, refuses, show, unexpected } from "./conformance.entity.functions.js"
import type { ConformanceCheck } from "./conformance.entity.js"
import { makeCore } from "./core.adapter.js"
import type { Core } from "./core.port.js"
import { dataOf, liveEvent, stored, storedEvent } from "./event.entity.functions.js"
import type { EventDefinition, KernelEvent, StoredDraft, StoredEvent } from "./event.entity.js"
import { Owner, Seq, SessionId, TurnNumber } from "./ids.entity.js"
import type { JournalStorage } from "./journal-storage.port.js"
import { byCreation } from "./session.entity.functions.js"
import type { Sessions } from "./sessions.port.js"
import { turnEnded, turnStarted } from "./vocabulary.entity.functions.js"
import { listenerFailedEvent, turnEndedEvent, turnStartedEvent } from "./vocabulary.entity.js"

type CoreShape = Context.Service.Shape<typeof Core>
type SessionsShape = Context.Service.Shape<typeof Sessions>
type JournalStorageShape = Context.Service.Shape<typeof JournalStorage>

/**
 * A session plugin as the kit opens it: a fresh one per check, over an
 * empty store of its own and the `Core` the kit hands it, released with
 * its scope. It gives that store too: the kit writes to it what another
 * writer would have left there (a turn never closed, a journal of another
 * format, an end stored under an open turn).
 *
 * @public
 */
export interface SessionsSubject {
  readonly open: (core: CoreShape) => Effect.Effect<{ readonly sessions: SessionsShape; readonly storage: JournalStorageShape }, never, Scope.Scope>
}

const owner = Owner.make("kit-owner")

/** The kit's own record: any plugin's event, as far as a session plugin knows. */
const noted = storedEvent("kit", "noted", { data: Schema.Struct({ text: Schema.String }), skippable: true, tags: ["trace"] })
const note = (text: string) => stored(noted, { text })
/** The kit's own live event: what a part holding the open session says of its turn. */
const glanced = liveEvent("kit", "glanced", { data: Schema.Struct({ text: Schema.String }), tags: ["trace"] })
/** A record as an object written by hand, with every field a draft has: what `stored` alone may make. */
const handBuilt: Omit<StoredEvent, "seq" | "at" | "turn"> = { name: noted.name, data: { text: "by hand" }, skippable: noted.skippable, tags: noted.tags }

/** What a body fails with in the checks of a failing turn. */
class KitFailure extends Schema.TaggedError<KitFailure>()("KitFailure", { message: Schema.String }) {}

const STARTED = turnStartedEvent.name
const ENDED = turnEndedEvent.name
const watched: ReadonlyArray<EventDefinition<Schema.Json>> = [turnStartedEvent, noted, glanced, turnEndedEvent]

/**
 * The sessions contract as checks, each over a fresh session plugin: a
 * created session reads back empty, and two creations give two ids
 * (`create`); a turn stores `core.session.turn.started`, what its body
 * appends and `core.session.turn.ended`, at consecutive places, its body
 * reading what it appended, and the next turn is numbered after it
 * (`turn`); a turn opened with `open` closes when its scope closes, with
 * the scope's outcome (completed, failed, interrupted), and every record
 * names the turn it was stored in (`open`); every stored event is announced on `Core` after it is in the
 * journal, under the same name, with its session and turn (`announce`); a
 * turn asked for while one is open is refused and stores nothing (`busy`);
 * a turn of one session does not hold another (`isolated`);
 * a body that fails still closes the turn, with the failure as its outcome
 * and the caller's own error, and the next turn runs (`closes`); so does a
 * body that is interrupted, whose session is free once the end of its turn
 * reached the stream (`interrupt`); a waiting listener that fails on
 * an appended event fails the append after the event is stored, and the
 * turn closes (`listener`); a listener that fails on the turn's end fails
 * nothing, leaves the session free and is reported as
 * `core.listener.failed` (`close-listener`); the session stays busy until
 * the end of its turn was announced, so its events reach listeners in
 * journal order (`ordered`); an open session kept after its turn closed
 * appends nothing (`closed-append`); a body's append of a record named
 * under `core.` is refused with `ReservedName`, and nothing is stored or
 * announced (`reserved-name`); a value `stored` did not make, an object
 * written by hand or a copy of a draft, is refused with `NotADraft`
 * (`not-a-draft`); a live event published through the open session is heard
 * on `Core` with its session and turn and stored nowhere, and refused once
 * the turn closed (`publish`); a session never created is refused
 * before any body runs (`missing`); a session asked for with an empty
 * owner, or a parent that is no id, is refused with `InvalidSession`
 * (`invalid-session`); every session is listed with its header, by
 * creation (`list`); a turn a writer that is gone left open is closed by
 * `recover` as `Abandoned` and announced, the next turn runs, a free
 * session is left as it is, and a turn this plugin holds is refused
 * (`recover`); a turn another writer closed in the store stores nothing
 * more: its append is refused, its close adds no second end and is heard
 * once, and the next turn opens (`recovered-writer`); a journal of another
 * format reads back and is listed, and no turn opens or is recovered on it
 * (`format`).
 *
 * @public
 */
export const sessionsConformance = (subject: SessionsSubject): ReadonlyArray<ConformanceCheck> => {
  /** One check over a fresh `Core` and session plugin, with every watched event as the kit's waiting listener saw it. */
  const check = (
    name: string,
    id: string,
    body: (parts: { readonly core: CoreShape; readonly sessions: SessionsShape; readonly storage: JournalStorageShape; readonly seen: Effect.Effect<ReadonlyArray<KernelEvent>> }) => Effect.Effect<void, { readonly _tag: string; readonly message: string }, Scope.Scope>,
  ): ConformanceCheck => ({
    id,
    name,
    run: Effect.scoped(Effect.gen(function* () {
      const core = yield* makeCore()
      const seen = yield* Ref.make<ReadonlyArray<KernelEvent>>([])
      const { sessions, storage } = yield* subject.open(core)
      yield* Effect.forEach(watched, (definition) =>
        core.on(definition, (event) => Ref.update(seen, (all) => [...all, event]), { wait: true, name: "kit-watch" }), { concurrency: 1, discard: true })
      yield* body({ core, sessions, storage, seen: Ref.get(seen) })
    })).pipe(unexpected(id)),
  })
  const names = (events: ReadonlyArray<{ readonly name: string }>) => events.map((event) => event.name)
  /**
   * The next end of a turn as the stream hands it over, read from now. A
   * session is free by the time its end is there, so this is what to wait
   * for before the turn after one whose caller did not wait. A careless
   * subject may never hand it over: none after two seconds.
   */
  const endOnStream = (core: CoreShape) => Effect.map(
    Effect.forkScoped(Stream.runHead(Stream.filter(core.events, (event) => event.name === ENDED)), { startImmediately: true }),
    (reader) => Effect.timeoutOption(Fiber.join(reader), "2 seconds"),
  )
  /** Wait for a signal a careless subject may never give: none after two seconds. */
  const within = <A>(signal: Deferred.Deferred<A>) => Effect.timeoutOption(Deferred.await(signal), "2 seconds")
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
    check("a turn of one session does not hold another session", "isolated", ({ sessions }) => Effect.gen(function* () {
      const first = yield* sessions.create({ owner })
      const second = yield* sessions.create({ owner })
      const inside = yield* sessions.turn(first, () => sessions.turn(second, (session) => Effect.as(session.append(note("in the other session")), session.turn)))
      yield* expect("isolated", inside === 1, `a turn of another session, run inside a turn, was turn ${inside}`)
      const [one, other] = [yield* sessions.read(first), yield* sessions.read(second)]
      yield* expect("isolated", show(names(one.events)) === show([STARTED, ENDED]) && show(names(other.events)) === show([STARTED, noted.name, ENDED]),
        `two sessions hold ${show(names(one.events))} and ${show(names(other.events))}`)
    })),
    check("a turn opened in a scope closes with the scope, and its records name their turn", "open", ({ core, sessions }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      yield* Effect.scoped(Effect.flatMap(sessions.open(id), (session) => session.append(note("answered"))))
      yield* Effect.exit(Effect.scoped(Effect.flatMap(sessions.open(id), () => Effect.fail(new KitFailure({ message: "the turn failed" })))))
      const running = yield* Deferred.make<void>()
      const handedOver = yield* endOnStream(core)
      const fiber = yield* Effect.forkChild(Effect.scoped(Effect.flatMap(sessions.open(id), () => Effect.andThen(Deferred.succeed(running, undefined), Effect.never))))
      const started = yield* within(running)
      yield* expect("open", Option.isSome(started), "a turn opened in a scope never ran what followed the open")
      yield* Fiber.interrupt(fiber)
      yield* handedOver
      const journal = yield* sessions.read(id)
      const ends = journal.events.filter((event) => event.name === ENDED).map((event) => outcomeOf(Option.some(event)))
      yield* expect("open", show(ends) === show(["Completed", "Failed", "Interrupted"]), `three turns opened in a scope ended ${show(ends)}`)
      yield* expect("open", show(journal.events.map((event) => event.turn)) === show([1, 1, 1, 2, 2, 3, 3]),
        `the records of three turns name the turns ${show(journal.events.map((event) => event.turn))}`)
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
    check("a body that is interrupted still closes the turn, and the next turn runs once its end reached the stream", "interrupt", ({ core, sessions }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      const running = yield* Deferred.make<void>()
      const handedOver = yield* endOnStream(core)
      const fiber = yield* Effect.forkChild(sessions.turn(id, () => Effect.andThen(Deferred.succeed(running, undefined), Effect.never)))
      yield* Deferred.await(running)
      yield* Fiber.interrupt(fiber)
      const journal = yield* sessions.read(id)
      yield* expect("interrupt", show(names(journal.events)) === show([STARTED, ENDED]) && outcomeOf(Option.fromNullishOr(journal.events.at(-1))) === "Interrupted",
        `an interrupted turn left ${show(journal.events)}`)
      // The interrupted caller did not wait for the end to be announced. Once the stream has it, the session is free.
      yield* handedOver
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
    check("a listener that fails on the turn's end fails nothing and is reported", "close-listener", ({ core, sessions }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      const reported = yield* Deferred.make<{ readonly listener: string; readonly event: string }>()
      yield* core.on(listenerFailedEvent, (failure) => Deferred.succeed(reported, failure.data), { name: "kit-watch" })
      yield* core.on(turnEndedEvent, () => Effect.fail(new KitFailure({ message: "the listener failed" })), { wait: true, name: "kit-failing" })
      const value = yield* sessions.turn(id, () => Effect.succeed("done"))
      yield* expect("close-listener", value === "done", `a turn whose end a listener failed returned ${show(value)}`)
      const failure = yield* within(reported)
      yield* expect("close-listener", Option.exists(failure, (data) => data.listener === "kit-failing" && data.event === ENDED), `the failure was reported as ${show(Option.getOrNull(failure))}`)
      const next = yield* sessions.turn(id, (session) => Effect.succeed(session.turn))
      yield* expect("close-listener", next === 2, `the turn after one whose end a listener failed was ${next}`)
    })),
    check("the session stays busy until its turn's end was announced, so its events are announced in journal order", "ordered", ({ core, sessions, seen }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      const entered = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const ends = yield* Ref.make(0)
      // The first end is held by a listener the publisher waits for; the ones after it are not.
      yield* core.on(turnEndedEvent, () => Effect.flatMap(Ref.updateAndGet(ends, (count) => count + 1), (count) =>
        count === 1 ? Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go)) : Effect.void), { wait: true, name: "kit-slow" })
      const first = yield* Effect.forkChild(sessions.turn(id, (session) => session.append(note("one"))))
      yield* expect("ordered", Option.isSome(yield* within(entered)), "the end of a turn never reached a listener that waits for it")
      yield* refuses("ordered", "a turn asked for while the end of the turn before is being announced", sessions.turn(id, () => Effect.void),
        (error) => error._tag === "SessionRefused" && error.reason === "SessionBusy")
      yield* Deferred.succeed(go, undefined)
      yield* Fiber.join(first)
      yield* sessions.turn(id, (session) => session.append(note("two")))
      const announced = (yield* seen).map((event) => event._tag === "Stored" ? event.seq : 0)
      const journal = yield* sessions.read(id)
      yield* expect("ordered", show(announced) === show(journal.events.map((event) => event.seq)), `the events were announced at ${show(announced)}, stored at ${show(journal.events.map((event) => event.seq))}`)
    })),
    check("an open session kept after its turn closed appends nothing", "closed-append", ({ sessions }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      const kept = yield* sessions.turn(id, (session) => Effect.succeed(session))
      yield* refuses("closed-append", "an append to a session whose turn closed", kept.append(note("late")), (error) => error._tag === "SessionRefused" && error.reason === "NoOpenTurn")
      const journal = yield* sessions.read(id)
      yield* expect("closed-append", show(names(journal.events)) === show([STARTED, ENDED]), `an append after the turn closed left ${show(names(journal.events))}`)
    })),
    check("a record named under core. is refused, and nothing is stored or announced", "reserved-name", ({ sessions, seen }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      const drafts = [turnEnded(TurnNumber.make(1), { _tag: "Completed" }), turnStarted(TurnNumber.make(2))]
      yield* sessions.turn(id, (session) => Effect.forEach(drafts, (draft) => refuses("reserved-name", `an append of ${draft.name}`, session.append(draft),
        (error) => error._tag === "SessionRefused" && error.reason === "ReservedName"), { concurrency: 1, discard: true }))
      const journal = yield* sessions.read(id)
      yield* expect("reserved-name", show(names(journal.events)) === show([STARTED, ENDED]), `appends of core's records left ${show(names(journal.events))}`)
      // Of core's records, at most the turn's own start and end were announced (whether a plugin announces at all is `announce`).
      const announced = names(yield* seen)
      yield* expect("reserved-name", announced.length <= 2 && announced.every((name) => name === STARTED || name === ENDED), `appends of core's records announced ${show(announced)}`)
    })),
    check("a value `stored` did not make is refused, and nothing is stored or announced", "not-a-draft", ({ sessions, seen }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      const notDraft = (error: { readonly _tag: string; readonly reason?: string }) => error._tag === "SessionRefused" && error.reason === "NotADraft"
      yield* sessions.turn(id, (session) => Effect.gen(function* () {
        yield* refuses("not-a-draft", "an append of an object written by hand", session.append(handBuilt as StoredDraft), notDraft)
        // A copy of a draft is not the draft: a field changed on the way would not be its definition's.
        yield* refuses("not-a-draft", "an append of a copy of a draft", session.append({ ...note("copied") }), notDraft)
        yield* session.append(note("made"))
      }))
      const journal = yield* sessions.read(id)
      yield* expect("not-a-draft", show(names(journal.events)) === show([STARTED, noted.name, ENDED]), `appends of values \`stored\` did not make left ${show(names(journal.events))}`)
      const announced = (yield* seen).filter((event) => event.name === noted.name)
      yield* expect("not-a-draft", announced.length <= 1, `appends of values \`stored\` did not make announced ${announced.length} records`)
    })),
    check("a live event published through the open session is heard on Core with its session and turn, and stored nowhere; refused once the turn closed", "publish", ({ sessions, seen }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      const kept = yield* sessions.turn(id, (session) => Effect.as(session.publish(glanced, { text: "looking" }), session))
      const heard = (yield* seen).filter((event) => event.name === glanced.name)
      yield* expect("publish", heard.length === 1 && heard.every((event) => event._tag === "Live" && event.session === id && event.turn === kept.turn && show(event.data) === show({ text: "looking" })),
        `a live event published in turn ${kept.turn} of ${id} was heard as ${show(heard)}`)
      const journal = yield* sessions.read(id)
      yield* expect("publish", show(names(journal.events)) === show([STARTED, ENDED]), `a published live event left ${show(names(journal.events))} in the journal`)
      yield* refuses("publish", "a publish through a session whose turn closed", kept.publish(glanced, { text: "late" }), (error) => error._tag === "SessionRefused" && error.reason === "NoOpenTurn")
      const after = (yield* seen).filter((event) => event.name === glanced.name)
      yield* expect("publish", after.length === 1, `a publish after the turn closed was heard: ${show(after)}`)
    })),
    check("a session never created is refused before any body runs", "missing", ({ sessions }) => Effect.gen(function* () {
      const ran = yield* Ref.make(false)
      yield* refuses("missing", "a turn of a session never created", sessions.turn(SessionId.make("kit-stranger"), () => Ref.set(ran, true)),
        (error) => error._tag === "JournalStorageError" && error.reason === "SessionMissing")
      yield* refuses("missing", "a read of a session never created", sessions.read(SessionId.make("kit-stranger")), (error) => error.reason === "SessionMissing")
      yield* expect("missing", !(yield* Ref.get(ran)), "the body of a turn of a missing session ran")
    })),
    check("a session asked for with an empty owner, or a parent that is no id, is refused", "invalid-session", ({ sessions }) => Effect.gen(function* () {
      const invalid = (error: { readonly _tag: string }) => error._tag === "InvalidSession"
      yield* refuses("invalid-session", "a session with an empty owner", sessions.create({ owner: "" }), invalid)
      yield* refuses("invalid-session", "a session with an owner of blanks", sessions.create({ owner: "   " }), invalid)
      yield* refuses("invalid-session", "a session with an empty parent", sessions.create({ owner, parent: "" }), invalid)
    })),
    check("every session is listed with its header, by creation", "list", ({ sessions }) => Effect.gen(function* () {
      const none = yield* sessions.list
      yield* expect("list", none.length === 0, `a plugin with no session listed ${show(none)}`)
      const first = yield* sessions.create({ owner })
      const child = yield* sessions.create({ owner: "kit-helper", parent: first })
      yield* sessions.turn(first, (session) => session.append(note("written to")))
      const listed = yield* sessions.list
      const stored = [(yield* sessions.read(first)).header, (yield* sessions.read(child)).header]
      yield* expect("list", show(Arr.sort(listed, byCreation)) === show(Arr.sort(stored, byCreation)), `two sessions with the headers ${show(stored)} were listed as ${show(listed)}`)
      yield* expect("list", show(listed) === show(Arr.sort(listed, byCreation)), `the sessions were listed as ${show(listed)}, not by creation time and then by id`)
      yield* expect("list", listed.some((header) => header.id === child && header.parent === first && header.owner === "kit-helper"),
        `a session created with a parent was listed as ${show(listed.filter((header) => header.id === child))}`)
    })),
    check("a turn left open by a writer that is gone is closed as abandoned, and the next turn runs", "recover", ({ sessions, storage, seen }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      yield* sessions.turn(id, (session) => session.append(note("before")))
      const free = yield* sessions.recover(id)
      yield* expect("recover", Option.isNone(free), `recovering a session with no turn open closed turn ${show(Option.getOrNull(free))}`)
      // What a writer that is gone left: the start of turn 2 and a record, in the store, and no end.
      const two = TurnNumber.make(2)
      yield* storage.append(id, Seq.make(3), two, turnStarted(two))
      yield* storage.append(id, Seq.make(4), two, note("left behind"))
      yield* refuses("recover", "a turn of a session whose turn was left open", sessions.turn(id, () => Effect.void),
        (error) => error._tag === "SessionRefused" && error.reason === "SessionBusy" && error.message.includes("Sessions.recover"))
      const closed = yield* sessions.recover(id)
      yield* expect("recover", Option.contains(closed, two), `recovering a session whose turn 2 was left open closed ${show(Option.getOrNull(closed))}`)
      const journal = yield* sessions.read(id)
      const ended = Option.fromNullishOr(journal.events.at(-1))
      yield* expect("recover", show(names(journal.events)) === show([STARTED, noted.name, ENDED, STARTED, noted.name, ENDED]) && outcomeOf(ended) === "Abandoned" && journal.events.at(-1)?.turn === 2,
        `a recovered session holds ${show(journal.events)}`)
      const heard = (yield* seen).at(-1)
      yield* expect("recover", heard !== undefined && heard._tag === "Stored" && heard.name === ENDED && heard.session === id && heard.seq === 6,
        `the end a recovery stored was announced as ${show(heard)}`)
      const again = yield* sessions.recover(id)
      const after = yield* sessions.read(id)
      yield* expect("recover", Option.isNone(again) && after.events.length === 6, `a second recovery closed ${show(Option.getOrNull(again))} and left ${show(names(after.events))}`)
      const next = yield* sessions.turn(id, (session) => Effect.succeed(session.turn))
      yield* expect("recover", next === 3, `the turn after a recovered one was turn ${next}`)
      yield* sessions.turn(id, () => refuses("recover", "recovering a session whose turn this plugin holds open", sessions.recover(id),
        (error) => error._tag === "SessionRefused" && error.reason === "SessionBusy"))
      const ends = (yield* sessions.read(id)).events.filter((event) => event.name === ENDED).map((event) => outcomeOf(Option.some(event)))
      yield* expect("recover", show(ends) === show(["Completed", "Abandoned", "Completed", "Completed"]), `four turns, the second recovered, ended ${show(ends)}`)
    })),
    check("a turn another writer closed stores nothing more, and the next turn opens", "recovered-writer", ({ sessions, storage, seen }) => Effect.gen(function* () {
      const id = yield* sessions.create({ owner })
      yield* sessions.turn(id, (session) => Effect.gen(function* () {
        yield* session.append(note("mine"))
        // Another writer, which took this one for gone, closes the turn in the store.
        yield* storage.append(id, Seq.make(2), session.turn, turnEnded(session.turn, { _tag: "Abandoned" }))
        yield* refuses("recovered-writer", "an append to a turn another writer closed", session.append(note("late")),
          (error) => error._tag === "SessionRefused" && error.reason === "NoOpenTurn")
      }))
      const journal = yield* sessions.read(id)
      yield* expect("recovered-writer", show(names(journal.events)) === show([STARTED, noted.name, ENDED]) && outcomeOf(Option.fromNullishOr(journal.events.at(-1))) === "Abandoned",
        `a turn another writer closed left ${show(journal.events)}: it holds one end, the other writer's`)
      const ends = (yield* seen).filter((event) => event.name === ENDED)
      yield* expect("recovered-writer", ends.length === 1 && outcomeOf(Option.fromNullishOr(ends[0])) === "Abandoned", `the close of a turn another writer closed was heard as ${show(ends)}`)
      const next = yield* sessions.turn(id, (session) => Effect.succeed(session.turn))
      yield* expect("recovered-writer", next === 2, `the turn after one another writer closed was turn ${next}`)
    })),
    check("a journal of another format reads back and is listed, and no turn opens or is recovered on it", "format", ({ sessions, storage }) => Effect.gen(function* () {
      const current = (yield* sessions.read(yield* sessions.create({ owner }))).header
      const other = SessionId.make("kit-other-format")
      const one = TurnNumber.make(1)
      yield* storage.create({ ...current, id: other, format: current.format + 1 })
      yield* storage.append(other, Seq.make(0), one, turnStarted(one))
      const read = yield* sessions.read(other)
      yield* expect("format", read.header.format === current.format + 1, `a header of format ${current.format + 1} read back as ${show(read.header)}`)
      yield* expect("format", (yield* sessions.list).some((header) => header.id === other), "a session of another format was not listed")
      const mismatch = (error: { readonly _tag: string; readonly reason?: string }) => error._tag === "SessionRefused" && error.reason === "FormatMismatch"
      yield* refuses("format", "a turn on a journal of another format", sessions.turn(other, () => Effect.void), mismatch)
      yield* refuses("format", "a recovery of a journal of another format", sessions.recover(other), mismatch)
      const after = yield* sessions.read(other)
      yield* expect("format", show(names(after.events)) === show([STARTED]), `the refused calls left ${show(names(after.events))} in a journal of another format`)
    })),
  ]
}
