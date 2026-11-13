import { describe, expect, test } from "bun:test"
import { Array as Arr, Context, Effect, Layer, Option, Order, Ref, Result } from "effect"
import {
  announced,
  CONVERSATION_READER,
  Core,
  EventName,
  kernel,
  Owner,
  Seq,
  SessionId,
  SessionRefused,
  Sessions,
  sessionsConformance,
  JournalStorage,
  journalStorageConformance,
  readerFor,
  readJournal,
  TurnNumber,
  UnknownRecord,
  messageOf,
  userMessage,
} from "@xandreed/core/kernel"
import { memoryConformance } from "./contracts/memory/memory.conformance.js"
import { Memory } from "./contracts/memory/memory.port.js"
import type { ConformanceCheck, JournalStorageSubject, PluginFailure, SessionsSubject, StoredEvent } from "@xandreed/core/kernel"
import type { MemorySubject } from "./contracts/memory/memory.conformance.js"
import { flatMemory, inProcessJournal, sessions, windowDroppedEvent, windowMemory } from "./index.js"

/*
 * The three contracts' kits: each passes on its stock plugin, and each
 * careless plugin written here fails the checks of what it is careless
 * about and no others, so a check holds only for a plugin that keeps the
 * promise it checks.
 */

type CoreShape = Context.Service.Shape<typeof Core>
type SessionsShape = Context.Service.Shape<typeof Sessions>

/** The ids of the checks of a kit that fail, sorted; a failure that names another check than the one it came from is told apart. */
const failedChecks = (checks: ReadonlyArray<ConformanceCheck>) =>
  Effect.runPromise(Effect.forEach(checks, (check) => Effect.result(check.run).pipe(
    Effect.map((result) => result._tag === "Failure" ? [result.failure.check === check.id ? check.id : `${check.id} reported as ${result.failure.check}`] : [])), { concurrency: 1 }))
    .then((failed) => Arr.sort(failed.flat(), Order.String))
const ids = (checks: ReadonlyArray<ConformanceCheck>) => checks.map((check) => check.id)
const sorted = (names: ReadonlyArray<string>) => Arr.sort(Arr.dedupe(names), Order.String)

const onCore = (core: CoreShape) => Layer.succeed(Core, core)
/** Build a plugin's layer over the services given and take the contract it provides. */
const built = <I, S, E, R>(key: Context.Key<I, S>, layer: Layer.Layer<I, E, R>, over: Layer.Layer<R>) =>
  Effect.map(Effect.orDie(Layer.build(Layer.provide(layer, over))), (services) => Context.get(services, key))

describe("the storage kit", () => {
  const stock: JournalStorageSubject = { open: built(JournalStorage, inProcessJournal(), Layer.empty) }
  const every = ["create", "append", "conflict", "read-from", "missing"]

  test("has the checks its doc comment lists, and passes on the in-process journal plugin", async () => {
    expect(ids(journalStorageConformance(stock))).toEqual(every)
    expect(await failedChecks(journalStorageConformance(stock))).toEqual([])
  })

  test("fails every check on a store that keeps nothing", async () => {
    const forgetful: JournalStorageSubject = {
      open: Effect.succeed(JournalStorage.of({
        create: () => Effect.void,
        append: (_id, expectedSeq, turn, event) => Effect.succeed({ seq: Seq.make(expectedSeq + 1), at: 0, turn, ...event }),
        read: (id) => Effect.succeed({ header: { id, owner: Owner.make("nobody"), format: 1 }, events: [] }),
      })),
    }
    expect(await failedChecks(journalStorageConformance(forgetful))).toEqual(sorted(every))
  })
})

describe("the sessions kit", () => {
  const over = (core: CoreShape) => Layer.provideMerge(inProcessJournal(), onCore(core))
  const stock: SessionsSubject = { open: (core) => built(Sessions, sessions(), over(core)) }
  const every = ["create", "turn", "announce", "busy", "isolated", "open", "closes", "interrupt", "listener", "close-listener", "ordered", "closed-append", "reserved-name", "missing", "invalid-session"]

  test("has the checks its doc comment lists, and passes on the stock session plugin", async () => {
    expect(ids(sessionsConformance(stock))).toEqual(every)
    expect(await failedChecks(sessionsConformance(stock))).toEqual([])
  })

  /** The checks each careless session plugin fails. */
  const careless = {
    // It announces on a bus of its own: nothing it stores reaches the listeners it was given.
    private: (): SessionsSubject => ({ open: () => Effect.flatMap(Layer.build(kernel()), (own) => built(Sessions, sessions(), over(Context.get(own, Core)))) }),
    // One busy flag for every session.
    oneFlag: (): SessionsSubject => ({
      open: (core) => Effect.gen(function* () {
        const inner = yield* built(Sessions, sessions(), over(core))
        const taken = yield* Ref.make(false)
        return Sessions.of({
          ...inner,
          turn: (id, body) => Effect.acquireUseRelease(
            Effect.flatMap(Ref.getAndSet(taken, true), (was) => was ? Effect.fail(new SessionRefused({ reason: "SessionBusy", message: "some session is busy" })) : Effect.void),
            () => inner.turn(id, body),
            () => Ref.set(taken, false),
          ),
        })
      }),
    }),
    // Two session plugins over one store, each turn on the other one: neither knows the other is still announcing an end.
    pooled: (): SessionsSubject => ({
      open: (core) => Effect.gen(function* () {
        const storage = yield* built(JournalStorage, inProcessJournal(), Layer.empty)
        const parts = Layer.merge(onCore(core), Layer.succeed(JournalStorage, storage))
        const pool = [yield* built(Sessions, sessions(), parts), yield* built(Sessions, sessions(), parts)]
        const turns = yield* Ref.make(0)
        const next = Effect.map(Ref.getAndUpdate(turns, (count) => count + 1), (count): SessionsShape => pool[count % 2] ?? pool[0] ?? Sessions.of({ create: () => Effect.die("empty pool"), read: () => Effect.die("empty pool"), open: () => Effect.die("empty pool"), turn: () => Effect.die("empty pool") }))
        return Sessions.of({
          create: (input) => Effect.flatMap(next, (one) => one.create(input)),
          read: (id) => Effect.flatMap(next, (one) => one.read(id)),
          open: (id) => Effect.flatMap(next, (one) => one.open(id)),
          turn: (id, body) => Effect.flatMap(next, (one) => one.turn(id, body)),
        })
      }),
    }),
    // A session asked for with an input that is no valid one is "helpfully" created for somebody.
    trusting: (): SessionsSubject => ({
      open: (core) => Effect.map(built(Sessions, sessions(), over(core)), (inner) => Sessions.of({
        ...inner,
        create: (input) => Effect.catchTag(inner.create(input), "InvalidSession", () => inner.create({ owner: "somebody" })),
      })),
    }),
    // An append after the turn closed is "helpfully" stored in a turn of its own.
    reopening: (): SessionsSubject => ({
      open: (core) => Effect.map(built(Sessions, sessions(), over(core)), (inner) => Sessions.of({
        ...inner,
        turn: (id, body) => inner.turn(id, (session) => body({
          ...session,
          append: (event) => Effect.catchIf(session.append(event), (error) => error._tag === "SessionRefused" && error.reason === "NoOpenTurn", () =>
            Effect.mapError(inner.turn(id, (again) => again.append(event)), (error) => error._tag === "UnknownRecord" ? new SessionRefused({ reason: "NoOpenTurn", message: error.message }) : error)),
        })),
      })),
    }),
    // A turn opened in a scope is closed at once: what follows the open finds the turn already over.
    detached: (): SessionsSubject => ({
      open: (core) => Effect.map(built(Sessions, sessions(), over(core)), (inner) => Sessions.of({
        ...inner,
        open: (id) => inner.turn(id, (session) => Effect.succeed(session)),
      })),
    }),
    // A record a body appends under core's names is "helpfully" stored under a name of the body's own.
    renaming: (): SessionsSubject => ({
      open: (core) => Effect.map(built(Sessions, sessions(), over(core)), (inner) => Sessions.of({
        ...inner,
        turn: (id, body) => inner.turn(id, (session) => body({
          ...session,
          append: (event) => Effect.catchIf(session.append(event), (error) => error._tag === "SessionRefused" && error.reason === "ReservedName", () =>
            session.append({ ...event, name: EventName.make(`plugin.renamed.${event.name}`) })),
        })),
      })),
    }),
    // It appends what a body gives it and announces it, with no start, no end, no phase and no check that the session exists.
    turnless: (): SessionsSubject => ({
      open: (core) => Effect.gen(function* () {
        const storage = yield* built(JournalStorage, inProcessJournal(), Layer.empty)
        const only = SessionId.make("the-only-session")
        const sessionOf = (id: SessionId) => ({
          id,
          turn: TurnNumber.make(1),
          journal: Effect.map(storage.read(id), (journal) => journal.events),
          append: (event: Parameters<typeof storage.append>[3]) => Effect.flatMap(storage.read(id), (journal) => storage.append(id, Seq.make(journal.events.length), TurnNumber.make(1), event)).pipe(
            Effect.tap((kept) => core.publish(announced({ id }, kept))),
          ),
        })
        return Sessions.of({
          create: () => Effect.as(Effect.ignore(storage.create({ id: only, owner: Owner.make("nobody"), format: 1 }), { log: "Debug", message: "the careless plugin keeps one session" }), only),
          read: (id) => Effect.catchTag(storage.read(id), "JournalStorageError", () => Effect.succeed({ header: { id, owner: Owner.make("nobody"), format: 1 as const }, events: [] })),
          open: (id) => Effect.succeed(sessionOf(id)),
          turn: (id, body) => body(sessionOf(id)),
        })
      }),
    }),
  }

  test("each careless session plugin fails the checks of what it is careless about, and between them every check", async () => {
    const failed = {
      private: await failedChecks(sessionsConformance(careless.private())),
      detached: await failedChecks(sessionsConformance(careless.detached())),
      oneFlag: await failedChecks(sessionsConformance(careless.oneFlag())),
      pooled: await failedChecks(sessionsConformance(careless.pooled())),
      renaming: await failedChecks(sessionsConformance(careless.renaming())),
      reopening: await failedChecks(sessionsConformance(careless.reopening())),
      trusting: await failedChecks(sessionsConformance(careless.trusting())),
      turnless: await failedChecks(sessionsConformance(careless.turnless())),
    }
    expect(failed.private).toEqual(["announce", "close-listener", "listener", "ordered"])
    expect(failed.detached).toEqual(["open"])
    expect(failed.oneFlag).toEqual(["isolated"])
    expect(failed.pooled).toEqual(["ordered"])
    expect(failed.renaming).toEqual(["reserved-name"])
    expect(failed.reopening).toEqual(["closed-append"])
    expect(failed.trusting).toEqual(["invalid-session"])
    expect(failed.turnless).toEqual(sorted(every))
  }, 60_000)
})

describe("the memory kit", () => {
  const budgetTokens = 200
  const subject = (name: string, layer: Layer.Layer<Memory, PluginFailure, Core>, budget: number | null = budgetTokens): MemorySubject =>
    ({ name, ...(budget === null ? {} : { budgetTokens: budget }), open: (core) => built(Memory, layer, onCore(core)) })
  const every = ["turn-message", "conversation", "other-uses", "own-records", "prefix", "fits", "over-budget", "unknown-skipped", "unknown-refused", "unknown-conversation-refused", "foreign"]

  test("has the checks its doc comment lists, and passes on the window memory plugin", async () => {
    expect(ids(memoryConformance(subject("window", windowMemory({ budgetTokens }))))).toEqual(every)
    expect(await failedChecks(memoryConformance(subject("window", windowMemory({ budgetTokens }))))).toEqual([])
  })

  test("passes on the flat memory plugin, which keeps to no budget and so is not held to one", async () => {
    const flat = subject("flat", flatMemory, null)
    expect(ids(memoryConformance(flat))).toEqual(every.filter((id) => id !== "fits" && id !== "over-budget"))
    expect(await failedChecks(memoryConformance(flat))).toEqual([])
  })

  /** A careless memory: what it sends, read from the journal as it stands, and what it writes while it builds. */
  const careless = (name: string, pick: (journal: ReadonlyArray<StoredEvent>) => ReadonlyArray<{ readonly role: "user" | "assistant"; readonly content: string }>, options: { readonly writes?: boolean } = {}) =>
    subject(name, Layer.succeed(Memory, Memory.of({
      context: (session) => Effect.gen(function* () {
        if (options.writes === true) yield* session.append(userMessage("a note in the conversation's name"))
        return pick(yield* session.journal)
      }),
    })))
  /** Every message a record bears, whatever the record is for. */
  const bearing = (journal: ReadonlyArray<{ readonly message?: { readonly _tag: "User" | "Assistant"; readonly text: string } }>) =>
    journal.flatMap((event) => event.message === undefined ? [] : [{ role: event.message._tag === "User" ? "user" as const : "assistant" as const, content: event.message.text }])

  /** The window memory, but it refuses every record it does not know, whoever wrote it and whatever the record says. */
  const strict = () => subject("window", Layer.effect(Memory, Effect.gen(function* () {
    const inner = Context.get(yield* Effect.orDie(Layer.build(Layer.provide(windowMemory({ budgetTokens }), onCore(yield* Core)))), Memory)
    const known: ReadonlyArray<string> = [...CONVERSATION_READER.knows, windowDroppedEvent.name]
    return Memory.of({
      context: (session) => Effect.flatMap(session.journal, (journal) => {
        const stranger = journal.find((event) => !known.includes(event.name))
        return stranger === undefined ? inner.context(session) : Effect.fail(new UnknownRecord({ name: stranger.name, seq: stranger.seq, message: "this memory reads nothing it does not know" }))
      }),
    })
  })))

  /**
   * The window memory, but it judges unknown records under its own prefix alone: it reads the journal with a reader
   * over core's (`readerFor("window", own)`), not over the conversation's, so a record of the conversation it does not
   * know passes as another plugin's, and the window below never sees it.
   */
  const ownPrefixOnly = () => subject("window", Layer.effect(Memory, Effect.gen(function* () {
    const inner = Context.get(yield* Effect.orDie(Layer.build(Layer.provide(windowMemory({ budgetTokens }), onCore(yield* Core)))), Memory)
    const reader = readerFor("window", [windowDroppedEvent])
    const ofTheConversation = (name: string) => name.startsWith("conversation.")
    return Memory.of({
      context: (session) => Effect.flatMap(session.journal, (journal) => Result.match(readJournal(reader)(journal), {
        onFailure: Effect.fail,
        onSuccess: () => inner.context({ ...session, journal: Effect.succeed(journal.filter((event) => !ofTheConversation(event.name) || CONVERSATION_READER.knows.includes(event.name))) }),
      })),
    })
  })))

  test("each careless memory fails the checks of what it is careless about, and between them every check", async () => {
    // It sends every message any record bears, reads no flag and keeps to no budget.
    const everything = await failedChecks(memoryConformance(careless("everything", bearing)))
    expect(everything).toEqual(["fits", "other-uses", "over-budget", "unknown-conversation-refused", "unknown-refused"])
    // It sends nothing.
    const nothing = await failedChecks(memoryConformance(careless("nothing", () => [])))
    expect(nothing).toEqual(["conversation", "fits", "over-budget", "turn-message", "unknown-conversation-refused", "unknown-refused"])
    // It writes a record in the conversation's name, then sends the last three messages of the conversation, each as the user's.
    const sloppy = await failedChecks(memoryConformance(careless("sloppy", (journal) => journal.flatMap((event) => Option.toArray(messageOf(event))).slice(-3).map((message) => ({ role: "user" as const, content: message.text })), { writes: true })))
    expect(sloppy).toEqual(["conversation", "fits", "over-budget", "own-records", "prefix", "turn-message", "unknown-conversation-refused", "unknown-refused"])
    // It refuses records it should pass over: another plugin's, a record of another use, and its own that may be skipped.
    const refusing = await failedChecks(memoryConformance(strict()))
    expect(refusing).toEqual(["foreign", "other-uses", "unknown-skipped"])
    // It reads its own prefix and not the conversation's: an unknown record of the conversation passes.
    expect(await failedChecks(memoryConformance(ownPrefixOnly()))).toEqual(["unknown-conversation-refused"])
    expect(sorted([...everything, ...nothing, ...sloppy, ...refusing])).toEqual(sorted(every))
  })
})
