import { describe, expect, test } from "bun:test"
import { Array as Arr, Context, Effect, Layer, Match, Option, Order, Ref, Result, Schema } from "effect"
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
} from "@xandreed/core"
import { memoryConformance } from "./contracts/memory/memory.conformance.js"
import { Memory } from "./contracts/memory/memory.port.js"
import type { ConformanceCheck, JournalStorageSubject, Message, OpenSession, PluginFailure, ReservedTag, SessionsSubject, StoredDraft, StoredEvent } from "@xandreed/core"
import type { MemorySubject } from "./contracts/memory/memory.conformance.js"
import type { CuratorSubject, EmbedderSubject, FilePath, FilesSubject, KeyValueStore, SearchSubject, SummarizerSubject, Vector, VectorKey, VectorStoreSubject } from "./index.js"
import { filesSearch, Search, searchConformance } from "./index.js"
import { CurationFailed, curationOf, Curator, curatorConformance } from "./index.js"
import { EmbedFailed, Embedder, embedderConformance, inMemoryVectors, recordedEmbedder, VectorsRefused, VectorStore, vectorStoreConformance } from "./index.js"
import { FileChanged, Files, filesConformance, inMemoryFiles, flatMemory, inProcessJournal, messageText, paired, pointed, promptMessage, sessions, Summarizer, summarizerConformance, SummaryFailed, summaryMemory, webStorageJournal, flatMemoryWith } from "./index.js"

/*
 * The contracts' kits: each passes on its stock plugin, and each
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
  const every = ["create", "append", "conflict", "read-from", "missing", "list", "fork"]

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
        fork: () => Effect.void,
      })),
    }
    expect(await failedChecks(journalStorageConformance(forgetful))).toEqual(sorted(every))
  })

  test("fails the check of a branch on a store that makes one by creating it and appending a copy of each event", async () => {
    // The design ADR 0016 rejected: places, turns and envelopes are kept, but each copy is stamped with the time it was
    // copied at. The copy is a draft of the kit's own record, so only the time can differ.
    const noted = storedEvent("kit", "noted", { data: Schema.Json, skippable: true, tags: ["kit.noted"] })
    const copyOf = (event: StoredEvent): StoredDraft => stored(noted, event.data, event.message === undefined ? {} : { message: event.message })
    const appending: JournalStorageSubject = {
      open: Effect.map(built(JournalStorage, inProcessJournal(), Layer.empty), (storage) => JournalStorage.of({
        ...storage,
        fork: (header) => Effect.flatMap(storage.read(header.branch.of), (from) => Effect.andThen(
          storage.create(header),
          Effect.forEach(from.events.filter((event) => event.seq <= header.branch.through), (event) =>
            storage.append(header.id, Seq.make(event.seq - 1), event.turn, copyOf(event)), { concurrency: 1, discard: true }),
        )),
      })),
    }
    expect(await failedChecks(journalStorageConformance(appending))).toEqual(["fork"])
  })

  const webOver = (store: KeyValueStore, prefix = "kit:") => built(JournalStorage, webStorageJournal(store, { prefix }), Layer.empty)

  test("a branch the storage refuses part way is taken back: no key under its id, and the session it was cut from as it was", async () => {
    for (const refused of ["s-branch:2", "s-branch:header"]) {
      const values = memoryStore()
      // A storage that is full when the branch's event 2, or its header, is written.
      const full: KeyValueStore = { ...values, get length() { return values.length }, setItem: (key, value) => {
        if (key === `kit:${refused}`) Result.getOrThrowWith(Result.fail("the storage is full"), (why) => new Error(why))
        values.setItem(key, value)
      } }
      const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const storage = yield* webOver(full)
        const source = SessionId.make("s-source")
        yield* storage.create({ id: source, owner: Owner.make("learner"), createdAt: 1, format: JOURNAL_FORMAT })
        yield* Effect.forEach([0, 1, 2], (at) => storage.append(source, Seq.make(at), TurnNumber.make(1), stored(storedEvent("kit", "noted", { data: Schema.Json, skippable: true, tags: ["kit.noted"] }), { at })), { concurrency: 1, discard: true })
        const before = yield* storage.read(source)
        const refusal = yield* Effect.flip(storage.fork({ id: SessionId.make("s-branch"), owner: Owner.make("learner"), createdAt: 2, format: JOURNAL_FORMAT, branch: { of: source, through: Seq.make(3) } }))
        const after = yield* storage.read(source)
        return { reason: refusal.reason, unchanged: JSON.stringify(after) === JSON.stringify(before), listed: (yield* storage.list).map((header) => String(header.id)) }
      })))
      const left = Array.from({ length: values.length }, (_, index) => values.key(index)).filter((key) => key?.startsWith("kit:s-branch"))
      expect({ refused, ...outcome, left }).toEqual({ refused, reason: "Unavailable", unchanged: true, listed: ["s-source"], left: [] })
    }
  })
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
      const [a, b, nested] = [yield* webOver(store, "a:"), yield* webOver(store, "b:"), yield* webOver(store, "a:inner:")]
      yield* a.create(header)
      yield* a.append(header.id, Seq.make(0), TurnNumber.make(1), userMessage("Hello"))
      // A store whose prefix starts with another's: its sessions are its own.
      yield* nested.create({ ...header, id: SessionId.make("s-2") })
      return { a: yield* a.list, b: yield* b.list, nested: yield* nested.list, missing: yield* Effect.flip(b.read(header.id)), keys: Array.from({ length: store.length }, (_, index) => store.key(index)) }
    })))
    expect(result.a.map((listed): string => listed.id)).toEqual(["s-1"])
    expect(result.b).toEqual([])
    expect(result.nested.map((listed): string => listed.id)).toEqual(["s-2"])
    expect(result.missing.reason).toBe("SessionMissing")
    expect(Arr.sort(result.keys.flatMap((key) => key === null ? [] : [key]), Order.String)).toEqual(["a:inner:s-2:header", "a:s-1:1", "a:s-1:header", "b:not-a-session", "somebody-else"])
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
  const every = ["create", "turn", "announce", "busy", "isolated", "open", "closes", "interrupt", "listener", "close-listener", "ordered", "closed-append", "reserved-name", "not-a-draft", "publish", "missing", "invalid-session", "list", "recover", "recovered-writer", "format", "fork"]

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
        const next = Effect.map(Ref.getAndUpdate(turns, (count) => count + 1), (count): SessionsShape => pool[count % 2] ?? pool[0] ?? Sessions.of({ create: () => Effect.die("empty pool"), read: () => Effect.die("empty pool"), list: Effect.die("empty pool"), recover: () => Effect.die("empty pool"), open: () => Effect.die("empty pool"), turn: () => Effect.die("empty pool"), fork: () => Effect.die("empty pool") }))
        return { storage, sessions: Sessions.of({
          create: (input) => Effect.flatMap(next, (one) => one.create(input)),
          read: (id) => Effect.flatMap(next, (one) => one.read(id)),
          list: Effect.flatMap(next, (one) => one.list),
          recover: (id) => Effect.flatMap(next, (one) => one.recover(id)),
          open: (id) => Effect.flatMap(next, (one) => one.open(id)),
          turn: (id, body) => Effect.flatMap(next, (one) => one.turn(id, body)),
          fork: (id, options) => Effect.flatMap(next, (one) => one.fork(id, options)),
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
    // A branch "helpfully" takes the whole journal, the turn still open in it included.
    wholeBranch: (): SessionsSubject => changed((inner, _core, storage) => Sessions.of({
      ...inner,
      fork: (id) => Effect.flatMap(storage.read(id), (journal) => Effect.as(
        storage.fork({ ...journal.header, id: SessionId.make(`${id}-whole`), createdAt: journal.header.createdAt + 1, branch: { of: id, through: Seq.make(journal.events.length) } }),
        SessionId.make(`${id}-whole`),
      )),
    })),
    // A branch announces every record it copies, as if each were stored again.
    loudBranch: (): SessionsSubject => changed((inner, core) => Sessions.of({
      ...inner,
      fork: (id, options) => Effect.tap(inner.fork(id, options), (branch) => Effect.flatMap(inner.read(branch), (journal) =>
        Effect.forEach(journal.events, (event) => Effect.ignore(core.publish(announced({ id: branch }, event)), { log: "Debug", message: "a copied record announced" }), { concurrency: 1, discard: true }))),
    })),
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
          // A branch is the session itself.
          fork: (id) => Effect.succeed(id),
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
      wholeBranch: await failedChecks(sessionsConformance(careless.wholeBranch())),
      loudBranch: await failedChecks(sessionsConformance(careless.loudBranch())),
    }
    // Its events, a published live one included, go to a Core of its own.
    // The end a recovery stores, and the end another writer stored, are announced there too.
    expect(failed.private).toEqual(["announce", "close-listener", "listener", "ordered", "publish", "recover", "recovered-writer"])
    // Its turn opened in a scope is already closed: a branch cut "before the open turn" takes that turn too.
    expect(failed.detached).toEqual(["fork", "open"])
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
    // It reads no format either: a journal of another format is branched too.
    expect(failed.wholeBranch).toEqual(["fork", "format"])
    expect(failed.loudBranch).toEqual(["fork"])
    expect(failed.turnless).toEqual(sorted(every))
  }, 60_000)
})

describe("the memory kit", () => {
  const budgetTokens = 200
  const subject = (name: string, layer: Layer.Layer<Memory, PluginFailure, Core>, budget: number | null = budgetTokens): MemorySubject =>
    ({ name, ...(budget === null ? {} : { budgetTokens: budget }), open: (core) => built(Memory, layer, onCore(core)) })
  const every = ["turn-message", "conversation", "pairs", "other-uses", "own-records", "prefix", "fits", "over-budget", "unknown-skipped", "unknown-refused", "unknown-conversation-refused", "foreign"]

  test("passes on the flat memory plugin, which keeps to no budget and so is not held to one", async () => {
    const flat = subject("flat", flatMemory, null)
    expect(ids(memoryConformance(flat))).toEqual(every.filter((id) => id !== "fits" && id !== "over-budget"))
    expect(await failedChecks(memoryConformance(flat))).toEqual([])
  })

  test("has the checks its doc comment lists, and passes on the summary memory plugin, over a summarizer that answers in a few words", async () => {
    const summarizer = Layer.succeed(Summarizer, Summarizer.of({ summarize: ({ messages }) => Effect.succeed(`${messages.length} messages about long things`) }))
    const summary = subject("summary", Layer.provide(summaryMemory({ budgetTokens }), summarizer))
    expect(ids(memoryConformance(summary))).toEqual(every)
    expect(await failedChecks(memoryConformance(summary))).toEqual([])
  })

  const pointers = { overTokens: 60, previewTokens: 10 }
  const pointerChecks = ["pointer", "pointer-whole", "pointer-stable", "pointer-budget"]
  /** Where the kit runs a memory's pointer checks: after `pairs`' neighbours, before the unknown-record ones. */
  const everyWithPointers = [...every.slice(0, every.indexOf("unknown-skipped")), ...pointerChecks, ...every.slice(every.indexOf("unknown-skipped"))]
  /** A flat memory that reads each record with `read`: `messageOf`, or a function that points. */
  const flatReading = (read: (record: StoredEvent, journal: ReadonlyArray<StoredEvent>) => Option.Option<Message>) => Layer.succeed(Memory, Memory.of({
    context: (session) => Effect.flatMap(session.journal, (journal) => Effect.map(Effect.fromResult(readJournal(vocabularyOf("flat", [], CONVERSATION_VOCABULARY))(journal)), (records) =>
      paired(records.flatMap((record) => Option.toArray(read(record, journal)))).map(promptMessage))),
  }))

  test("a memory that sends long results as pointers is held to it: the summary memory with pointers, flatMemoryWith, and a flat one that points written by hand", async () => {
    const summarizer = Layer.succeed(Summarizer, Summarizer.of({ summarize: ({ messages }) => Effect.succeed(`${messages.length} messages about long things`) }))
    const summary = { ...subject("summary", Layer.provide(summaryMemory({ budgetTokens, pointers }), summarizer)), pointers }
    expect(ids(memoryConformance(summary))).toEqual(everyWithPointers)
    expect(await failedChecks(memoryConformance(summary))).toEqual([])
    const unbounded = everyWithPointers.filter((id) => id !== "fits" && id !== "over-budget" && id !== "pointer-budget")
    const shipped = { ...subject("flat", flatMemoryWith({ pointers }), null), pointers }
    expect(ids(memoryConformance(shipped))).toEqual(unbounded)
    expect(await failedChecks(memoryConformance(shipped))).toEqual([])
    const sent = pointed(pointers)
    const flat = { ...subject("flat", flatReading((record) => sent(record)), null), pointers }
    expect(ids(memoryConformance(flat))).toEqual(unbounded)
    expect(await failedChecks(memoryConformance(flat))).toEqual([])
    // A memory that sends every result whole fails each pointer check, when it says it points.
    expect(await failedChecks(memoryConformance({ ...subject("summary", Layer.provide(summaryMemory({ budgetTokens }), summarizer)), pointers }))).toEqual(["pointer", "pointer-budget", "pointer-stable"])
    expect(await failedChecks(memoryConformance({ ...subject("flat", flatMemory, null), pointers }))).toEqual(["pointer", "pointer-stable"])
  })

  test("each careless pointing memory fails the check of what it is careless about, and no other", async () => {
    const sent = pointed(pointers)
    // It points a result its tool marked whole.
    const unmarked = (record: StoredEvent): StoredEvent => record.message?._tag === "ToolResult" ? { ...record, message: { _tag: "ToolResult", id: record.message.id, name: record.message.name, result: record.message.result, isFailure: record.message.isFailure } } : record
    const pointsWhole = { ...subject("flat", flatReading((record) => sent(unmarked(record))), null), pointers }
    expect(await failedChecks(memoryConformance(pointsWhole))).toEqual(["pointer-whole"])
    // It sends a result whole in the turn that fetched it, and as a pointer from the next turn on: the prompt's start changes once per result.
    const lateToPoint = { ...subject("flat", flatReading((record, journal) => record.turn === journal.at(-1)?.turn ? messageOf(record) : sent(record)), null), pointers }
    expect(await failedChecks(memoryConformance(lateToPoint))).toEqual(["pointer-stable"])
    // It counts every result whole against its budget, then sends pointers.
    const summarizer = Layer.succeed(Summarizer, Summarizer.of({ summarize: ({ messages }) => Effect.succeed(`${messages.length} messages about long things`) }))
    const countsWhole = { ...subject("summary", Layer.effect(Memory, Effect.gen(function* () {
      const core = yield* Core
      const counting = Context.get(yield* Effect.orDie(Layer.build(Layer.provide(Layer.provide(summaryMemory({ budgetTokens }), summarizer), onCore(core)))), Memory)
      const pointing = Context.get(yield* Effect.orDie(Layer.build(Layer.provide(Layer.provide(summaryMemory({ budgetTokens, pointers }), summarizer), onCore(core)))), Memory)
      return Memory.of({ context: (session) => Effect.flatMap(counting.context(session), () => pointing.context(session)) })
    }))), pointers }
    expect(await failedChecks(memoryConformance(countsWhole))).toEqual(["pointer-budget"])
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

  /** The flat memory, but it refuses every record it does not know, whoever wrote it and whatever the record says. */
  const strict = () => subject("flat", Layer.effect(Memory, Effect.gen(function* () {
    const inner = Context.get(yield* Layer.build(Layer.provide(flatMemory, onCore(yield* Core))), Memory)
    const known: ReadonlyArray<string> = CONVERSATION_VOCABULARY.knows
    return Memory.of({
      context: (session) => Effect.flatMap(session.journal, (journal) => {
        const stranger = journal.find((event) => !known.includes(event.name))
        return stranger === undefined ? inner.context(session) : Effect.fail(new UnknownRecord({ name: stranger.name, seq: stranger.seq, message: "this memory reads nothing it does not know" }))
      }),
    })
  })), null)

  /**
   * The flat memory, but it judges unknown records under its own prefix alone: it reads the journal with a vocabulary
   * over core's (`vocabularyOf("flat", own)`), not over the conversation's, so a record of the conversation it does not
   * know passes as another plugin's, and the flat memory below never sees it.
   */
  const ownPrefixOnly = () => subject("flat", Layer.effect(Memory, Effect.gen(function* () {
    const inner = Context.get(yield* Layer.build(Layer.provide(flatMemory, onCore(yield* Core))), Memory)
    const vocabulary = vocabularyOf("flat", [])
    const ofTheConversation = (name: string) => name.startsWith("conversation.")
    return Memory.of({
      context: (session) => Effect.flatMap(session.journal, (journal) => Result.match(readJournal(vocabulary)(journal), {
        onFailure: Effect.fail,
        onSuccess: () => inner.context({ ...session, journal: Effect.succeed(journal.filter((event) => !ofTheConversation(event.name) || CONVERSATION_VOCABULARY.knows.includes(event.name))) }),
      })),
    })
  })), null)

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
    // It pairs by id alone: a call left open is sent when a later call of the same id was answered.
    const byId = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> => {
      const answered = new Set(messages.flatMap((message) => message._tag === "ToolResult" ? [message.id] : []))
      return messages.flatMap((message): ReadonlyArray<Message> => message._tag !== "Assistant" ? [message]
        : message.text.length === 0 && message.toolCalls.every((call) => !answered.has(call.id)) ? [] : [{ ...message, toolCalls: message.toolCalls.filter((call) => answered.has(call.id)) }])
    }
    const pairedById = await failedChecks(memoryConformance(subject("byid", Layer.succeed(Memory, Memory.of({
      context: (session) => Effect.flatMap(session.journal, (journal) => Effect.map(Effect.fromResult(readJournal(vocabularyOf("byid", [], CONVERSATION_VOCABULARY))(journal)), (records) =>
        byId(records.flatMap((record) => Option.toArray(messageOf(record)))).map(promptMessage))),
    })), null)))
    expect(pairedById).toEqual(["pairs"])
    // It pairs in order, and tells the calls of one answer apart by their id alone: both of two calls under one id
    // are sent where one result answered.
    const byMessage = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> => {
      const open = new Map<string, number>()
      const answered = new Set<string>()
      const answers = new Set<number>()
      messages.forEach((message, at) => {
        if (message._tag === "Assistant") message.toolCalls.forEach((call) => open.set(call.id, at))
        if (message._tag !== "ToolResult") return
        const asked = open.get(message.id)
        if (asked === undefined) return
        open.delete(message.id)
        answered.add(`${asked} ${message.id}`)
        answers.add(at)
      })
      return messages.flatMap((message, at): ReadonlyArray<Message> => Match.valueTags(message, {
        User: (user): ReadonlyArray<Message> => [user],
        ToolResult: (result): ReadonlyArray<Message> => (answers.has(at) ? [result] : []),
        Assistant: (assistant): ReadonlyArray<Message> => {
          const toolCalls = assistant.toolCalls.filter((call) => answered.has(`${at} ${call.id}`))
          return assistant.text.length === 0 && toolCalls.length === 0 ? [] : [{ ...assistant, toolCalls }]
        },
      }))
    }
    const pairedByMessage = await failedChecks(memoryConformance(subject("bymessage", Layer.succeed(Memory, Memory.of({
      context: (session) => Effect.flatMap(session.journal, (journal) => Effect.map(Effect.fromResult(readJournal(vocabularyOf("bymessage", [], CONVERSATION_VOCABULARY))(journal)), (records) =>
        byMessage(records.flatMap((record) => Option.toArray(messageOf(record)))).map(promptMessage))),
    })), null)))
    expect(pairedByMessage).toEqual(["pairs"])
    // It tells calls apart by their place, and gives a result to the last call of its id: of two calls one answer
    // makes under one id, the second is sent beside the first one's result.
    const byLast = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> => {
      const open = new Map<string, string>()
      const pairs = new Map<string, number>()
      messages.forEach((message, at) => Match.valueTags(message, {
        User: () => {},
        Assistant: ({ toolCalls }) => toolCalls.forEach((call, index) => open.set(call.id, `${at} ${index}`)),
        ToolResult: ({ id }) => {
          const asked = open.get(id)
          if (asked === undefined) return
          open.delete(id)
          pairs.set(asked, at)
        },
      }))
      const answers = new Set(pairs.values())
      return messages.flatMap((message, at): ReadonlyArray<Message> => Match.valueTags(message, {
        User: (user): ReadonlyArray<Message> => [user],
        ToolResult: (result): ReadonlyArray<Message> => (answers.has(at) ? [result] : []),
        Assistant: (assistant): ReadonlyArray<Message> => {
          const toolCalls = assistant.toolCalls.filter((_, index) => pairs.has(`${at} ${index}`))
          return assistant.text.length === 0 && toolCalls.length === 0 ? [] : [{ ...assistant, toolCalls }]
        },
      }))
    }
    const pairedByLast = await failedChecks(memoryConformance(subject("bylast", Layer.succeed(Memory, Memory.of({
      context: (session) => Effect.flatMap(session.journal, (journal) => Effect.map(Effect.fromResult(readJournal(vocabularyOf("bylast", [], CONVERSATION_VOCABULARY))(journal)), (records) =>
        byLast(records.flatMap((record) => Option.toArray(messageOf(record)))).map(promptMessage))),
    })), null)))
    expect(pairedByLast).toEqual(["pairs"])
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

describe("the curator kit", () => {
  const subject = (curate: Context.Service.Shape<typeof Curator>["curate"]): CuratorSubject => ({ open: Effect.succeed(Curator.of({ curate })) })
  const nothing = `{"entities":[],"aliases":[],"memories":[],"restates":[],"forget":[]}`

  test("has the check its doc comment lists, and passes on a curator that answers each prompt, or fails as the contract says", async () => {
    const asked: Array<string> = []
    const scripted = subject(({ prompt, job }) => Effect.sync(() => {
      asked.push(`${job.purpose} ${job.source} ${job.attempt} ${prompt.split("\n")[0]?.slice(0, 40)}`)
      return nothing
    }))
    expect(ids(curatorConformance(scripted))).toEqual(["answers"])
    expect(await failedChecks(curatorConformance(scripted))).toEqual([])
    // It was asked once for each purpose, with the prompt of that purpose.
    expect(asked).toEqual(["extract s1 1 You keep the long-term memory of an assi", "review s1 1 You check a proposed update to an assist"])
    expect(await failedChecks(curatorConformance(subject(() => Effect.fail(new CurationFailed({ message: "the model is down" })))))).toEqual([])
    // What the kit sends as a proposal to review is a reply `curationOf` reads.
    expect(Option.isSome(curationOf(nothing))).toBe(true)
  })

  test("fails on a curator that answers with nothing, for either purpose, and on one that dies", async () => {
    expect(await failedChecks(curatorConformance(subject(() => Effect.succeed(" \n"))))).toEqual(["answers"])
    // Blank only when it is asked to review: the second half of the check.
    expect(await failedChecks(curatorConformance(subject(({ job }) => Effect.succeed(job.purpose === "review" ? "" : nothing))))).toEqual(["answers"])
    expect(await failedChecks(curatorConformance(subject(({ job }) => Effect.succeed(job.purpose === "extract" ? "" : nothing))))).toEqual(["answers"])
    expect(await failedChecks(curatorConformance(subject(() => Effect.die("the curator broke"))))).toEqual(["answers"])
  })
})

describe("the files kit", () => {
  type FilesShape = Context.Service.Shape<typeof Files>
  /** A workspace in memory with some of its calls replaced, each given the one it replaces. */
  const careless = (change: (inner: FilesShape) => Partial<FilesShape>): FilesSubject => ({
    open: Effect.map(built(Files, inMemoryFiles(), Layer.empty), (inner) => Files.of({ ...inner, ...change(inner) })),
  })

  test("has the checks its doc comment lists, and passes on the workspace in memory", async () => {
    const stock: FilesSubject = { open: built(Files, inMemoryFiles(), Layer.empty) }
    expect(ids(filesConformance(stock))).toEqual(["read-back", "not-found", "overwrite", "expected", "changed", "list"])
    expect(await failedChecks(filesConformance(stock))).toEqual([])
  })

  test("each careless workspace fails the check of what it is careless about, and between them every check", async () => {
    const failed = {
      // It keeps text without the spaces at its ends.
      trimming: await failedChecks(filesConformance(careless((inner) => ({ write: (path, text, expected) => inner.write(path, text.trim(), expected) })))),
      // It reads a path with no file as an empty one.
      emptyForMissing: await failedChecks(filesConformance(careless((inner) => ({ read: (path) => Effect.catchTag(inner.read(path), "FileNotFound", () => Effect.succeed("")) })))),
      // It keeps the first text written to a path, when nothing is expected.
      firstWins: await failedChecks(filesConformance(careless((inner) => ({
        write: (path, text, expected) => expected === undefined ? Effect.ignore(inner.write(path, text, { _tag: "Absent" }), { log: "Debug", message: "the careless workspace keeps the first text" }) : inner.write(path, text, expected),
      })))),
      // It refuses every write that expects anything.
      suspicious: await failedChecks(filesConformance(careless((inner) => ({
        write: (path, text, expected) => expected === undefined ? inner.write(path, text) : Effect.fail(new FileChanged({ path, message: "always changed" })),
      })))),
      // It writes whatever was expected.
      blind: await failedChecks(filesConformance(careless((inner) => ({ write: (path, text) => inner.write(path, text) })))),
      // It lists in the order files were written.
      unordered: await failedChecks(filesConformance(careless((inner) => {
        const written: Array<FilePath> = []
        return {
          write: (path, text, expected) => Effect.tap(inner.write(path, text, expected), () => Effect.sync(() => { if (!written.includes(path)) written.push(path) })),
          list: (folder) => Effect.succeed(Option.match(folder, { onNone: () => [...written], onSome: (name) => written.filter((path) => path.startsWith(`${name}/`)) })),
        }
      }))),
      // It lists every name that starts like the folder's.
      byStart: await failedChecks(filesConformance(careless((inner) => ({
        list: (folder) => Effect.map(inner.list(Option.none()), (all) => Option.match(folder, { onNone: () => all, onSome: (name) => all.filter((path) => path.startsWith(name)) })),
      })))),
    }
    expect(failed).toEqual({
      trimming: ["read-back"],
      emptyForMissing: ["changed", "not-found"],
      firstWins: ["overwrite"],
      suspicious: ["expected"],
      blind: ["changed"],
      unordered: ["list"],
      byStart: ["list"],
    })
  })
})

describe("the search kit", () => {
  type SearchShape = Context.Service.Shape<typeof Search>
  /** The search over a workspace in memory holding `files`. */
  const over = (files: Readonly<Record<string, string>>) => built(Search, filesSearch(), inMemoryFiles(files))
  /** The search with its `find` replaced, given the one it replaces. */
  const careless = (change: (inner: SearchShape) => SearchShape["find"]): SearchSubject => ({
    open: (files) => Effect.map(over(files), (inner) => Search.of({ find: change(inner) })),
  })

  test("has the checks its doc comment lists, and passes on the search over a workspace in memory", async () => {
    const stock: SearchSubject = { open: over }
    expect(ids(searchConformance(stock))).toEqual(["literal", "regex", "order", "folder", "glob", "limit", "line", "refused", "none"])
    expect(await failedChecks(searchConformance(stock))).toEqual([])
  })

  test("each careless search fails the check of what it is careless about, and between them every check", async () => {
    const failed = {
      // It reads every pattern as a regular expression.
      alwaysRegex: await failedChecks(searchConformance(careless((inner) => (query) => inner.find({ ...query, regex: true })))),
      // It reads every pattern as it is written.
      neverRegex: await failedChecks(searchConformance(careless((inner) => (query) => inner.find({ ...query, regex: false })))),
      // It gives the matches last file first.
      backwards: await failedChecks(searchConformance(careless((inner) => (query) => Effect.map(inner.find(query), (found) => ({
        ...found, matches: Arr.sort(found.matches, Order.mapInput(Order.flip(Order.String), (match: { readonly path: string }) => match.path)),
      }))))),
      // It searches the whole workspace, whatever the folder.
      everywhere: await failedChecks(searchConformance(careless((inner) => ({ folder: _, ...query }) => inner.find(query)))),
      // It matches a glob against the whole path, slash or not.
      byPath: await failedChecks(searchConformance(careless((inner) => (query) => query.glob === undefined || query.glob.includes("/") ? inner.find(query) : inner.find({ ...query, glob: `**/${query.glob}` }).pipe(
        Effect.map((found) => ({ ...found, matches: found.matches.filter((match) => match.path === query.glob) })),
      )))),
      // It gives every match, past the limit.
      unlimited: await failedChecks(searchConformance(careless((inner) => (query) => Effect.map(inner.find({ ...query, limit: 1_000 }), (found) => ({ ...found, more: false }))))),
      // It counts columns from 0.
      fromZero: await failedChecks(searchConformance(careless((inner) => (query) => Effect.map(inner.find(query), (found) => ({ ...found, matches: found.matches.map((match) => ({ ...match, column: match.column - 1 })) }))))),
      // It finds nothing where it cannot use a pattern.
      quiet: await failedChecks(searchConformance(careless((inner) => (query) => Effect.catchTag(inner.find(query), "PatternInvalid", () => Effect.succeed({ matches: [], more: false, skipped: 0 }))))),
      // It says there is more when it finds nothing.
      hopeful: await failedChecks(searchConformance(careless((inner) => (query) => Effect.map(inner.find(query), (found) => found.matches.length === 0 ? { ...found, more: true } : found)))),
    }
    expect(failed).toEqual({
      alwaysRegex: ["literal"],
      neverRegex: ["refused", "regex"],
      backwards: ["limit", "order"],
      everywhere: ["folder"],
      byPath: ["glob"],
      unlimited: ["limit"],
      fromZero: ["line"],
      quiet: ["refused"],
      hopeful: ["none"],
    })
  })
})

describe("the embedder kit", () => {
  type EmbedderShape = Context.Service.Shape<typeof Embedder>
  const texts = ["The cat sleeps on the mat.", "Stock prices fell sharply today.", "A recipe for lemon cake."]
  const stock = recordedEmbedder({
    model: "kit-model",
    vectors: {
      query: { [texts[0] ?? ""]: [1, 0, 0, 0], [texts[1] ?? ""]: [0, 1, 0, 0], [texts[2] ?? ""]: [0, 0, 1, 0] },
      passage: { [texts[0] ?? ""]: [1, 0, 0, 0.5], [texts[1] ?? ""]: [0, 1, 0, 0.5], [texts[2] ?? ""]: [0, 0, 1, 0.5] },
    },
  })
  /** The recorded embedder with its `embed` replaced, given the one it replaces. */
  const careless = (change: (inner: EmbedderShape) => EmbedderShape["embed"]): EmbedderSubject => ({
    texts,
    open: Effect.map(built(Embedder, stock, Layer.empty), (inner) => Embedder.of({ ...inner, embed: change(inner) })),
  })

  test("has the checks its doc comment lists, and passes on the recorded embedder", async () => {
    const subject: EmbedderSubject = { texts, open: built(Embedder, stock, Layer.empty) }
    expect(ids(embedderConformance(subject))).toEqual(["order", "same", "dimension", "empty", "both"])
    expect(await failedChecks(embedderConformance(subject))).toEqual([])
  })

  test("a subject with fewer than three texts, or texts too alike to tell apart, fails order in words", async () => {
    const run = (subject: EmbedderSubject) => Effect.runPromise(Effect.flip(embedderConformance(subject)[0]?.run ?? Effect.die("the kit has no checks")))
    expect((await run({ texts: texts.slice(0, 2), open: built(Embedder, stock, Layer.empty) })).message).toBe("the subject gives 2 texts: the kit needs three or more")
    const alike = recordedEmbedder({ model: "alike", vectors: { query: {}, passage: { a: [1, 0], b: [2, 0], c: [0, 1] } } })
    expect((await run({ texts: ["a", "b", "c"], open: built(Embedder, alike, Layer.empty) })).message).toBe("\"a\" and \"b\" gave vectors too alike to tell apart (cosine 1.0000): give texts of different meanings")
  })

  test("each careless embedder fails the check of what it is careless about, and between them every check", async () => {
    let calls = 0
    const failed = {
      // It gives a batch's vectors in the reverse order.
      outOfOrder: await failedChecks(embedderConformance(careless((inner) => (batch, as) => Effect.map(inner.embed(batch, as), (vectors) => [...vectors].reverse())))),
      // Its vectors grow a little longer with every call: they point the same way, but are not the same.
      drifting: await failedChecks(embedderConformance(careless((inner) => (batch, as) => Effect.map(inner.embed(batch, as), (vectors) => {
        calls += 1
        return vectors.map((vector) => vector.map((x) => x * (1 + calls / 1000)))
      })))),
      // It gives one text a vector one number longer.
      mixed: await failedChecks(embedderConformance(careless((inner) => (batch, as) => Effect.map(inner.embed(batch, as), (vectors) =>
        vectors.map((vector, index): Vector => batch[index] === texts[2] ? [...vector, 0] : vector))))),
      // It fails when it is given no texts.
      emptyFailing: await failedChecks(embedderConformance(careless((inner) => (batch, as) =>
        batch.length === 0 ? Effect.fail(new EmbedFailed({ message: "nothing to embed" })) : inner.embed(batch, as)))),
      // It gives a passage a vector one number longer than a query's.
      passageLonger: await failedChecks(embedderConformance(careless((inner) => (batch, as) => Effect.map(inner.embed(batch, as), (vectors) =>
        as === "passage" ? vectors.map((vector): Vector => [...vector, 0]) : vectors)))),
    }
    expect(failed).toEqual({
      outOfOrder: ["order"],
      drifting: ["same"],
      mixed: ["dimension"],
      emptyFailing: ["empty"],
      passageLonger: ["both"],
    })
  })
})

describe("the vector store kit", () => {
  type StoreShape = Context.Service.Shape<typeof VectorStore>
  const everything = Number.MAX_SAFE_INTEGER
  /** A store in memory with some of its calls replaced, each given the one it replaces. */
  const careless = (change: (inner: StoreShape) => Partial<StoreShape>): VectorStoreSubject => ({
    open: Effect.map(built(VectorStore, inMemoryVectors(), Layer.empty), (inner) => VectorStore.of({ ...inner, ...change(inner) })),
  })

  test("has the checks its doc comment lists, and passes on the store in memory", async () => {
    const stock: VectorStoreSubject = { open: built(VectorStore, inMemoryVectors(), Layer.empty) }
    expect(ids(vectorStoreConformance(stock))).toEqual(["replace", "order", "ties", "limit", "among", "has", "dimension", "empty"])
    expect(await failedChecks(vectorStoreConformance(stock))).toEqual([])
  })

  test("each careless store fails the check of what it is careless about, and between them every check", async () => {
    const failed = {
      // It keeps the first vector put under a key.
      notReplacing: await failedChecks(vectorStoreConformance(careless((inner) => ({
        put: (entries) => Effect.flatMap(inner.has(entries.map((entry) => entry.key)), (stored) => inner.put(entries.filter((entry) => !stored.includes(entry.key)))),
      })))),
      // It finds the least alike first (keys of one score still by code unit).
      wrongWay: await failedChecks(vectorStoreConformance(careless((inner) => ({
        search: (vector, options) => Effect.map(Effect.andThen(inner.search(vector, options), inner.search(vector, { ...options, limit: everything })), (found) =>
          Arr.sort(found, Order.combine(Order.mapInput(Order.Number, (scored: typeof found[number]) => scored.score), Order.mapInput(Order.String, (scored: typeof found[number]) => scored.key))).slice(0, options.limit)),
      })))),
      // It finds keys of one score in the order they were put.
      putOrder: await failedChecks(vectorStoreConformance(careless((inner) => {
        const order: Array<VectorKey> = []
        return {
          put: (entries) => Effect.tap(inner.put(entries), () => Effect.sync(() => { for (const { key } of entries) if (!order.includes(key)) order.push(key) })),
          search: (vector, options) => Effect.map(Effect.andThen(inner.search(vector, options), inner.search(vector, { ...options, limit: everything })), (found) =>
            Arr.sort(found, Order.combine(Order.mapInput(Order.flip(Order.Number), (scored: typeof found[number]) => scored.score), Order.mapInput(Order.Number, (scored: typeof found[number]) => order.indexOf(scored.key)))).slice(0, options.limit)),
        }
      }))),
      // It finds every key it holds, whatever the limit.
      unlimited: await failedChecks(vectorStoreConformance(careless((inner) => ({ search: (vector, options) => inner.search(vector, { ...options, limit: everything }) })))),
      // It searches the whole store, whatever it is searched among.
      ignoringAmong: await failedChecks(vectorStoreConformance(careless((inner) => ({ search: (vector, options) => inner.search(vector, { limit: options.limit }) })))),
      // It cuts the keys to search among at the limit before it passes over those not stored.
      cuttingAmong: await failedChecks(vectorStoreConformance(careless((inner) => ({
        search: (vector, options) => inner.search(vector, options.among === undefined ? options : { limit: options.limit, among: options.among.slice(0, options.limit) }),
      })))),
      // It says every key it is asked about is stored.
      lyingHas: await failedChecks(vectorStoreConformance(careless(() => ({ has: (keys) => Effect.succeed(keys) })))),
      // It keeps each entry of a put on its own, so a refused put keeps those before the one refused.
      halfPut: await failedChecks(vectorStoreConformance(careless((inner) => ({ put: (entries) => Effect.forEach(entries, (entry) => inner.put([entry]), { concurrency: 1, discard: true }) })))),
      // It refuses a search while it holds no vector, having no length to compare with.
      emptyRefusing: await failedChecks(vectorStoreConformance(careless((inner) => ({
        search: (vector, options) => Effect.flatMap(inner.search(vector, { limit: everything }), (all) => all.length === 0
          ? Effect.fail(new VectorsRefused({ reason: "dimension", message: "this store holds no vector yet" }))
          : inner.search(vector, options)),
      })))),
    }
    expect(failed).toEqual({
      notReplacing: ["replace"],
      wrongWay: ["order"],
      putOrder: ["ties"],
      unlimited: ["limit"],
      ignoringAmong: ["among"],
      cuttingAmong: ["among"],
      lyingHas: ["has"],
      halfPut: ["dimension"],
      emptyRefusing: ["empty"],
    })
  })
})
