import { describe, expect, test } from "bun:test"
import { Array as Arr, Context, Effect, Layer, Option, Order, Ref, Result, Schema } from "effect"
import {
  announced,
  CONVERSATION_VOCABULARY,
  isStoredDraft,
  JOURNAL_FORMAT,
  live,
  stored,
  storedEvent,
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
  vocabularyOf,
  readJournal,
  turnEnded,
  TurnNumber,
  UnknownRecord,
  messageOf,
  userMessage,
} from "@xandreed/core/kernel"
import { memoryConformance } from "./contracts/memory/memory.conformance.js"
import { Memory } from "./contracts/memory/memory.port.js"
import type { ConformanceCheck, JournalStorageSubject, Message, OpenSession, PluginFailure, ReservedTag, SessionsSubject, StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import type { MemorySubject } from "./contracts/memory/memory.conformance.js"
import type { KeyValueStore, SummarizerSubject } from "./index.js"
import { flatMemory, inProcessJournal, messageText, promptMessage, sessions, Summarizer, summarizerConformance, SummaryFailed, summaryMemory, webStorageJournal, windowDroppedEvent, windowMemory } from "./index.js"

/*
 * The three contracts' kits: each passes on its stock plugin, and each
 * careless plugin written here fails the checks of what it is careless
 * about and no others, so a check holds only for a plugin that keeps the
 * promise it checks.
 */

type CoreShape = Context.Service.Shape<typeof Core>
type SessionsShape = Context.Service.Shape<typeof Sessions>
type StorageShape = Context.Service.Shape<typeof JournalStorage>

/** A value with the five members the web storage journal uses, over a map: what a browser's `localStorage` is to it. */
const memoryStore = (): KeyValueStore => {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    key: (index) => Array.from(values.keys())[index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

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
  const every = ["create", "append", "conflict", "read-from", "missing", "list"]

  test("has the checks its doc comment lists, and passes on the in-process journal plugin", async () => {
    expect(ids(journalStorageConformance(stock))).toEqual(every)
    expect(await failedChecks(journalStorageConformance(stock))).toEqual([])
  })

  test("fails every check on a store that keeps nothing", async () => {
    const forgetful: JournalStorageSubject = {
      open: Effect.succeed(JournalStorage.of({
        create: () => Effect.void,
        append: (_id, expectedSeq, turn, event) => Effect.succeed({ seq: Seq.make(expectedSeq + 1), at: 0, turn, ...event }),
        read: (id) => Effect.succeed({ header: { id, owner: Owner.make("nobody"), createdAt: 0, format: 1 }, events: [] }),
        list: Effect.succeed([]),
      })),
    }
    expect(await failedChecks(journalStorageConformance(forgetful))).toEqual(sorted(every))
  })

  const webOver = (store: KeyValueStore, prefix = "kit:") => built(JournalStorage, webStorageJournal(store, { prefix }), Layer.empty)
  /** The web storage journal: a fresh storage per check, and two handles on one storage for the check of a reopening. */
  const web: JournalStorageSubject = {
    open: Effect.suspend(() => webOver(memoryStore())),
    pair: Effect.suspend(() => { const store = memoryStore(); return Effect.all([webOver(store), webOver(store)], { concurrency: 1 }) }),
  }
  const header = { id: SessionId.make("s-1"), owner: Owner.make("learner"), createdAt: 1, format: JOURNAL_FORMAT }

  test("passes on the web storage journal plugin, a second handle on the same storage included", async () => {
    expect(ids(journalStorageConformance(web))).toEqual([...every, "reopens"])
    expect(await failedChecks(journalStorageConformance(web))).toEqual([])
  })

  test("the web storage journal keeps to its prefix: two stores in one storage see none of each other's sessions, and no other key", async () => {
    const store = memoryStore()
    store.setItem("somebody-else", "not a journal")
    store.setItem("b:not-a-session", "not a journal either")
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const [a, b] = [yield* webOver(store, "a:"), yield* webOver(store, "b:")]
      yield* a.create(header)
      yield* a.append(header.id, Seq.make(0), TurnNumber.make(1), userMessage("Hello"))
      return { a: yield* a.list, b: yield* b.list, missing: yield* Effect.flip(b.read(header.id)), keys: Array.from({ length: store.length }, (_, index) => store.key(index)) }
    })))
    expect(result.a.map((listed): string => listed.id)).toEqual(["s-1"])
    expect(result.b).toEqual([])
    expect(result.missing.reason).toBe("SessionMissing")
    expect(Arr.sort(result.keys.flatMap((key) => key === null ? [] : [key]), Order.String)).toEqual(["a:s-1:1", "a:s-1:header", "b:not-a-session", "somebody-else"])
  })

  test("the web storage journal says what it cannot read, and what the storage refused", async () => {
    const store = memoryStore()
    const full: KeyValueStore = { length: 0, key: () => null, getItem: () => null, removeItem: () => {}, setItem: () => Result.getOrThrowWith(Result.fail("the quota is used up"), (why) => new Error(why)) }
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const storage = yield* webOver(store)
      yield* storage.create(header)
      yield* storage.append(header.id, Seq.make(0), TurnNumber.make(1), userMessage("Hello"))
      store.setItem("kit:s-1:1", "{ not json")
      const event = yield* Effect.flip(storage.read(header.id))
      store.setItem("kit:s-2:header", JSON.stringify({ id: "s-2", owner: "learner" }))
      const listed = yield* Effect.flip(storage.list)
      const refused = yield* Effect.flip(Effect.flatMap(webOver(full), (blocked) => blocked.create({ ...header, id: SessionId.make("s-3") })))
      return { event, listed, refused }
    })))
    expect([result.event.reason, result.event.message]).toEqual(["Unreadable", "the value stored under kit:s-1:1 is not a journal's: it was written by something else, or by another format"])
    expect([result.listed.reason, result.listed.message]).toEqual(["Unreadable", "the value stored under kit:s-2:header is not a journal's: it was written by something else, or by another format"])
    expect([result.refused.reason, result.refused.message]).toEqual(["Unavailable", "the storage refused: the quota is used up"])
  })
})

/** A record's fields as a draft of a definition of the careless plugin's own: what it makes of a value it should have refused. */
const redrafted = (event: { readonly data: Schema.Json; readonly skippable: boolean; readonly message?: StoredDraft["message"] }, plugin: string, name: string, tags: ReadonlyArray<ReservedTag>): StoredDraft =>
  stored(storedEvent(plugin, name, { data: Schema.Json, skippable: event.skippable, tags }), event.data, event.message === undefined ? {} : { message: event.message })

describe("the sessions kit", () => {
  /** The stock session plugin over a store, and that store: the in-process one when none is given. */
  const stockOver = (core: CoreShape, store: Layer.Layer<JournalStorage> = inProcessJournal()) => Effect.gen(function* () {
    const storage = yield* built(JournalStorage, store, Layer.empty)
    const inner = yield* built(Sessions, sessions(), Layer.merge(onCore(core), Layer.succeed(JournalStorage, storage)))
    return { sessions: inner, storage }
  })
  const stock: SessionsSubject = { open: (core) => stockOver(core) }
  /** The stock plugin with something about it changed. */
  const changed = (change: (inner: SessionsShape, core: CoreShape, storage: StorageShape) => SessionsShape): SessionsSubject => ({
    open: (core) => Effect.map(stockOver(core), ({ sessions: inner, storage }) => ({ sessions: change(inner, core, storage), storage })),
  })
  const every = ["create", "turn", "announce", "busy", "isolated", "open", "closes", "interrupt", "listener", "close-listener", "ordered", "closed-append", "reserved-name", "not-a-draft", "publish", "missing", "invalid-session", "list", "recover", "recovered-writer", "format"]

  test("passes on the stock session plugin over the web storage journal", async () => {
    const overWeb: SessionsSubject = { open: (core) => stockOver(core, webStorageJournal(memoryStore(), { prefix: "kit:" })) }
    expect(await failedChecks(sessionsConformance(overWeb))).toEqual([])
  })

  test("has the checks its doc comment lists, and passes on the stock session plugin", async () => {
    expect(ids(sessionsConformance(stock))).toEqual(every)
    expect(await failedChecks(sessionsConformance(stock))).toEqual([])
  })

  /** The checks each careless session plugin fails. */
  const careless = {
    // It announces on a bus of its own: nothing it stores reaches the listeners it was given.
    private: (): SessionsSubject => ({ open: () => Effect.flatMap(Layer.build(kernel()), (own) => stockOver(Context.get(own, Core))) }),
    // One busy flag for every session.
    oneFlag: (): SessionsSubject => ({
      open: (core) => Effect.gen(function* () {
        const { sessions: inner, storage } = yield* stockOver(core)
        const taken = yield* Ref.make(false)
        return { storage, sessions: Sessions.of({
          ...inner,
          turn: (id, body) => Effect.acquireUseRelease(
            Effect.flatMap(Ref.getAndSet(taken, true), (was) => was ? Effect.fail(new SessionRefused({ reason: "SessionBusy", message: "some session is busy" })) : Effect.void),
            () => inner.turn(id, body),
            () => Ref.set(taken, false),
          ),
        }) }
      }),
    }),
    // Two session plugins over one store, each turn on the other one: neither knows the other is still announcing an end.
    pooled: (): SessionsSubject => ({
      open: (core) => Effect.gen(function* () {
        const storage = yield* built(JournalStorage, inProcessJournal(), Layer.empty)
        const parts = Layer.merge(onCore(core), Layer.succeed(JournalStorage, storage))
        const pool = [yield* built(Sessions, sessions(), parts), yield* built(Sessions, sessions(), parts)]
        const turns = yield* Ref.make(0)
        const next = Effect.map(Ref.getAndUpdate(turns, (count) => count + 1), (count): SessionsShape => pool[count % 2] ?? pool[0] ?? Sessions.of({ create: () => Effect.die("empty pool"), read: () => Effect.die("empty pool"), list: Effect.die("empty pool"), recover: () => Effect.die("empty pool"), open: () => Effect.die("empty pool"), turn: () => Effect.die("empty pool") }))
        return { storage, sessions: Sessions.of({
          create: (input) => Effect.flatMap(next, (one) => one.create(input)),
          read: (id) => Effect.flatMap(next, (one) => one.read(id)),
          list: Effect.flatMap(next, (one) => one.list),
          recover: (id) => Effect.flatMap(next, (one) => one.recover(id)),
          open: (id) => Effect.flatMap(next, (one) => one.open(id)),
          turn: (id, body) => Effect.flatMap(next, (one) => one.turn(id, body)),
        }) }
      }),
    }),
    // A session asked for with an input that is no valid one is "helpfully" created for somebody.
    trusting: (): SessionsSubject => changed((inner) => Sessions.of({
        ...inner,
        create: (input) => Effect.catchTag(inner.create(input), "InvalidSession", () => inner.create({ owner: "somebody" })),
    })),
    // An append after the turn closed is "helpfully" stored in a turn of its own.
    reopening: (): SessionsSubject => changed((inner) => Sessions.of({
        ...inner,
        turn: (id, body) => inner.turn(id, (session) => body({
          ...session,
          append: (event) => Effect.catchIf(session.append(event), (error) => error._tag === "SessionRefused" && error.reason === "NoOpenTurn", () =>
            Effect.mapError(inner.turn(id, (again) => again.append(event)), (error) => error._tag === "UnknownRecord" ? new SessionRefused({ reason: "NoOpenTurn", message: error.message }) : error)),
        })),
    })),
    // A turn opened in a scope is closed at once: what follows the open finds the turn already over.
    detached: (): SessionsSubject => changed((inner) => Sessions.of({
        ...inner,
        open: (id) => inner.turn(id, (session) => Effect.succeed(session)),
    })),
    // A record a body appends under core's names is "helpfully" stored under a name of the body's own.
    renaming: (): SessionsSubject => changed((inner) => Sessions.of({
        ...inner,
        turn: (id, body) => inner.turn(id, (session) => body({
          ...session,
          append: (event) => Effect.catchIf(session.append(event), (error) => error._tag === "SessionRefused" && error.reason === "ReservedName", () =>
            session.append(redrafted(event, "renamed", event.name, ["turn"]))),
        })),
    })),
    // Whatever a body hands it is "helpfully" made into a draft: an object written by hand, or a copy of a draft, is stored as it reads.
    forgiving: (): SessionsSubject => changed((inner) => Sessions.of({
        ...inner,
        turn: (id, body) => inner.turn(id, (session) => body({ ...session, append: (event) => {
          const given: unknown = event
          return session.append(isStoredDraft(given) ? event : redrafted(event, "kit", "noted", ["trace"]))
        } })),
    })),
    // A live event is published whether or not the turn it is about is still open.
    late: (): SessionsSubject => changed((inner, core) => Sessions.of({
        ...inner,
        turn: (id, body) => inner.turn(id, (session) => body({ ...session, publish: (definition, data) => core.publish(live(definition, session, data)) })),
    })),
    // It lists only the sessions that have no parent.
    rootsOnly: (): SessionsSubject => changed((inner) => Sessions.of({ ...inner, list: Effect.map(inner.list, (headers) => headers.filter((header) => header.parent === undefined)) })),
    // It takes every session for a free one: a turn left open is left open.
    neverRecovering: (): SessionsSubject => changed((inner) => Sessions.of({ ...inner, recover: () => Effect.succeed(Option.none()) })),
    // It takes a journal it cannot read for a free session.
    formatBlind: (): SessionsSubject => changed((inner) => Sessions.of({
      ...inner,
      recover: (id) => Effect.catchIf(inner.recover(id), (error) => error._tag === "SessionRefused" && error.reason === "FormatMismatch", () => Effect.succeed(Option.none())),
    })),
    // A turn is closed with this plugin's own end, whatever the journal holds by then: another writer's end is followed by a second.
    insisting: (): SessionsSubject => changed((inner, _core, storage) => Sessions.of({
      ...inner,
      turn: (id, body) => Effect.flatMap(inner.turn(id, (session) => Effect.map(body(session), (value) => [value, session.turn] as const)), ([value, turn]) =>
        Effect.flatMap(storage.read(id), (journal) => journal.events.at(-1)?.at === undefined || !JSON.stringify(journal.events.at(-1)?.data).includes("Abandoned")
          ? Effect.succeed(value)
          : Effect.as(storage.append(id, Seq.make(journal.events.length), turn, turnEnded(turn, { _tag: "Completed" })), value))),
    })),
    // It appends what a body gives it and announces it, with no start, no end, no phase and no check that the session exists.
    turnless: (): SessionsSubject => ({
      open: (core) => Effect.gen(function* () {
        const storage = yield* built(JournalStorage, inProcessJournal(), Layer.empty)
        const only = SessionId.make("the-only-session")
        const sessionOf = (id: SessionId): OpenSession => ({
          id,
          turn: TurnNumber.make(1),
          journal: Effect.map(storage.read(id), (journal) => journal.events),
          publish: (definition, data) => core.publish(live(definition, { id, turn: TurnNumber.make(1) }, data)),
          append: (event: Parameters<typeof storage.append>[3]) => Effect.flatMap(storage.read(id), (journal) => storage.append(id, Seq.make(journal.events.length), TurnNumber.make(1), event)).pipe(
            Effect.tap((kept) => core.publish(announced({ id }, kept))),
          ),
        })
        return { storage, sessions: Sessions.of({
          create: () => Effect.as(Effect.ignore(storage.create({ id: only, owner: Owner.make("nobody"), createdAt: 0, format: 1 }), { log: "Debug", message: "the careless plugin keeps one session" }), only),
          read: (id) => Effect.catchTag(storage.read(id), "JournalStorageError", () => Effect.succeed({ header: { id, owner: Owner.make("nobody"), createdAt: 0, format: 1 as const }, events: [] })),
          list: Effect.succeed([]),
          recover: () => Effect.succeed(Option.none()),
          open: (id) => Effect.succeed(sessionOf(id)),
          turn: (id, body) => body(sessionOf(id)),
        }) }
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
      forgiving: await failedChecks(sessionsConformance(careless.forgiving())),
      late: await failedChecks(sessionsConformance(careless.late())),
      reopening: await failedChecks(sessionsConformance(careless.reopening())),
      trusting: await failedChecks(sessionsConformance(careless.trusting())),
      turnless: await failedChecks(sessionsConformance(careless.turnless())),
      rootsOnly: await failedChecks(sessionsConformance(careless.rootsOnly())),
      neverRecovering: await failedChecks(sessionsConformance(careless.neverRecovering())),
      formatBlind: await failedChecks(sessionsConformance(careless.formatBlind())),
      insisting: await failedChecks(sessionsConformance(careless.insisting())),
    }
    // Its events, a published live one included, go to a Core of its own.
    // The end a recovery stores, and the end another writer stored, are announced there too.
    expect(failed.private).toEqual(["announce", "close-listener", "listener", "ordered", "publish", "recover", "recovered-writer"])
    expect(failed.detached).toEqual(["open"])
    expect(failed.oneFlag).toEqual(["isolated"])
    // A recovery asked of the plugin that does not hold the open turn closes it under the one that does.
    expect(failed.pooled).toEqual(["ordered", "recover"])
    expect(failed.renaming).toEqual(["reserved-name"])
    expect(failed.forgiving).toEqual(["not-a-draft"])
    expect(failed.late).toEqual(["publish"])
    // An append to a turn another writer closed is refused the same way, and is "helpfully" stored too.
    expect(failed.reopening).toEqual(["closed-append", "recovered-writer"])
    expect(failed.trusting).toEqual(["invalid-session"])
    expect(failed.rootsOnly).toEqual(["list"])
    // It refuses no recovery either, a journal of another format's included.
    expect(failed.neverRecovering).toEqual(["format", "recover"])
    expect(failed.formatBlind).toEqual(["format"])
    expect(failed.insisting).toEqual(["recovered-writer"])
    expect(failed.turnless).toEqual(sorted(every))
  }, 60_000)
})

describe("the memory kit", () => {
  const budgetTokens = 200
  const subject = (name: string, layer: Layer.Layer<Memory, PluginFailure, Core>, budget: number | null = budgetTokens): MemorySubject =>
    ({ name, ...(budget === null ? {} : { budgetTokens: budget }), open: (core) => built(Memory, layer, onCore(core)) })
  const every = ["turn-message", "conversation", "pairs", "other-uses", "own-records", "prefix", "fits", "over-budget", "unknown-skipped", "unknown-refused", "unknown-conversation-refused", "foreign"]

  test("has the checks its doc comment lists, and passes on the window memory plugin", async () => {
    expect(ids(memoryConformance(subject("window", windowMemory({ budgetTokens }))))).toEqual(every)
    expect(await failedChecks(memoryConformance(subject("window", windowMemory({ budgetTokens }))))).toEqual([])
  })

  test("passes on the flat memory plugin, which keeps to no budget and so is not held to one", async () => {
    const flat = subject("flat", flatMemory, null)
    expect(ids(memoryConformance(flat))).toEqual(every.filter((id) => id !== "fits" && id !== "over-budget"))
    expect(await failedChecks(memoryConformance(flat))).toEqual([])
  })

  test("passes on the summary memory plugin, over a summarizer that answers in a few words", async () => {
    const summarizer = Layer.succeed(Summarizer, Summarizer.of({ summarize: ({ messages }) => Effect.succeed(`${messages.length} messages about long things`) }))
    const summary = subject("summary", Layer.provide(summaryMemory({ budgetTokens }), summarizer))
    expect(ids(memoryConformance(summary))).toEqual(every)
    expect(await failedChecks(memoryConformance(summary))).toEqual([])
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
  const bearing = (journal: ReadonlyArray<{ readonly message?: Message }>) =>
    journal.flatMap((event) => event.message === undefined ? [] : [{ role: event.message._tag === "User" ? "user" as const : "assistant" as const, content: messageText(event.message) }])

  /** The window memory, but it refuses every record it does not know, whoever wrote it and whatever the record says. */
  const strict = () => subject("window", Layer.effect(Memory, Effect.gen(function* () {
    const inner = Context.get(yield* Effect.orDie(Layer.build(Layer.provide(windowMemory({ budgetTokens }), onCore(yield* Core)))), Memory)
    const known: ReadonlyArray<string> = [...CONVERSATION_VOCABULARY.knows, windowDroppedEvent.name]
    return Memory.of({
      context: (session) => Effect.flatMap(session.journal, (journal) => {
        const stranger = journal.find((event) => !known.includes(event.name))
        return stranger === undefined ? inner.context(session) : Effect.fail(new UnknownRecord({ name: stranger.name, seq: stranger.seq, message: "this memory reads nothing it does not know" }))
      }),
    })
  })))

  /**
   * The window memory, but it judges unknown records under its own prefix alone: it reads the journal with a vocabulary
   * over core's (`vocabularyOf("window", own)`), not over the conversation's, so a record of the conversation it does not
   * know passes as another plugin's, and the window below never sees it.
   */
  const ownPrefixOnly = () => subject("window", Layer.effect(Memory, Effect.gen(function* () {
    const inner = Context.get(yield* Effect.orDie(Layer.build(Layer.provide(windowMemory({ budgetTokens }), onCore(yield* Core)))), Memory)
    const vocabulary = vocabularyOf("window", [windowDroppedEvent])
    const ofTheConversation = (name: string) => name.startsWith("conversation.")
    return Memory.of({
      context: (session) => Effect.flatMap(session.journal, (journal) => Result.match(readJournal(vocabulary)(journal), {
        onFailure: Effect.fail,
        onSuccess: () => inner.context({ ...session, journal: Effect.succeed(journal.filter((event) => !ofTheConversation(event.name) || CONVERSATION_VOCABULARY.knows.includes(event.name))) }),
      })),
    })
  })))

  test("each careless memory fails the checks of what it is careless about, and between them every check", async () => {
    // It sends every message any record bears, reads no flag and keeps to no budget.
    const everything = await failedChecks(memoryConformance(careless("everything", bearing)))
    expect(everything).toEqual(["fits", "other-uses", "over-budget", "pairs", "unknown-conversation-refused", "unknown-refused"])
    // It sends nothing.
    const nothing = await failedChecks(memoryConformance(careless("nothing", () => [])))
    expect(nothing).toEqual(["conversation", "fits", "over-budget", "pairs", "turn-message", "unknown-conversation-refused", "unknown-refused"])
    // It writes a record in the conversation's name, then sends the last three messages of the conversation, each as the user's.
    const sloppy = await failedChecks(memoryConformance(careless("sloppy", (journal) => journal.flatMap((event) => Option.toArray(messageOf(event))).slice(-3).map((message) => ({ role: "user" as const, content: messageText(message) })), { writes: true })))
    expect(sloppy).toEqual(["conversation", "fits", "over-budget", "own-records", "pairs", "prefix", "turn-message", "unknown-conversation-refused", "unknown-refused"])
    // It reads as the flat memory does, but sends every tool call, a call no result answers too.
    const unpairedVocabulary = vocabularyOf("unpaired", [], CONVERSATION_VOCABULARY)
    const unpaired = await failedChecks(memoryConformance(subject("unpaired", Layer.succeed(Memory, Memory.of({
      context: (session) => Effect.flatMap(session.journal, (journal) => Effect.map(Effect.fromResult(readJournal(unpairedVocabulary)(journal)), (records) =>
        records.flatMap((record) => Option.toArray(messageOf(record))).map(promptMessage))),
    })), null)))
    expect(unpaired).toEqual(["pairs"])
    // It refuses records it should pass over: another plugin's, a record of another use, and its own that may be skipped.
    const refusing = await failedChecks(memoryConformance(strict()))
    expect(refusing).toEqual(["foreign", "other-uses", "unknown-skipped"])
    // It reads its own prefix and not the conversation's: an unknown record of the conversation passes.
    expect(await failedChecks(memoryConformance(ownPrefixOnly()))).toEqual(["unknown-conversation-refused"])
    expect(sorted([...new Set([...everything, ...nothing, ...sloppy, ...refusing, ...unpaired])])).toEqual(sorted(every))
  })
})

describe("the summarizer kit", () => {
  const subject = (summarize: Context.Service.Shape<typeof Summarizer>["summarize"]): SummarizerSubject => ({ open: Effect.succeed(Summarizer.of({ summarize })) })

  test("has the check its doc comment lists, and passes on a summarizer that answers in a few words, or fails as the contract says", async () => {
    const wordy = subject(({ earlier, messages }) => Effect.succeed(`${Option.isSome(earlier) ? "Earlier, and " : ""}${messages.length} messages about a sum`))
    expect(ids(summarizerConformance(wordy))).toEqual(["answers"])
    expect(await failedChecks(summarizerConformance(wordy))).toEqual([])
    expect(await failedChecks(summarizerConformance(subject(() => Effect.fail(new SummaryFailed({ message: "the model is down" })))))).toEqual([])
  })

  test("fails on a summarizer that answers with nothing, with or without an earlier summary, and on one that dies", async () => {
    expect(await failedChecks(summarizerConformance(subject(() => Effect.succeed(" \n"))))).toEqual(["answers"])
    // Blank only when it is handed an earlier summary: the second half of the check.
    expect(await failedChecks(summarizerConformance(subject(({ earlier }) => Effect.succeed(Option.isSome(earlier) ? "" : "A sum."))))).toEqual(["answers"])
    expect(await failedChecks(summarizerConformance(subject(() => Effect.die("the summarizer broke"))))).toEqual(["answers"])
  })
})
