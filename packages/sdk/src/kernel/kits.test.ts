import { describe, expect, test } from "bun:test"
import { Array as Arr, Context, Effect, Layer, Order, Ref } from "effect"
import { LanguageModel } from "effect/ai"
import {
  announced,
  assistantDelta,
  assistantMessage,
  Core,
  estimateRequest,
  firstStep,
  kernel,
  LOOP_READER,
  Loop,
  loopConformance,
  Memory,
  memoryConformance,
  Owner,
  replyOf,
  requestSent,
  resolveRequest,
  Seq,
  SessionId,
  SessionRefused,
  Sessions,
  sessionsConformance,
  Settings,
  JournalStorage,
  journalStorageConformance,
  Tokens,
  TurnNumber,
  UnknownRecord,
  userMessage,
} from "@xandreed/core/kernel"
import type { AssistantMessage, ConformanceCheck, JournalStorageSubject, LoopScript, LoopSubject, MemorySubject, PluginFailure, SessionsSubject } from "@xandreed/core/kernel"
import { callModel, inProcessJournal, scriptedModel, sessions, stepLoop, windowDroppedEvent, windowMemory } from "./index.js"

/*
 * The four contracts' kits: each passes on its stock plugin, and each
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
        append: (_id, expectedSeq, event) => Effect.succeed({ seq: Seq.make(expectedSeq + 1), at: 0, ...event }),
        read: (id) => Effect.succeed({ header: { id, owner: Owner.make("nobody"), format: 1 }, events: [] }),
      })),
    }
    expect(await failedChecks(journalStorageConformance(forgetful))).toEqual(sorted(every))
  })
})

describe("the sessions kit", () => {
  const over = (core: CoreShape) => Layer.provideMerge(inProcessJournal(), onCore(core))
  const stock: SessionsSubject = { open: (core) => built(Sessions, sessions(), over(core)) }
  const every = ["create", "turn", "announce", "busy", "isolated", "closes", "interrupt", "listener", "close-listener", "ordered", "closed-append", "missing", "invalid-session"]

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
        const next = Effect.map(Ref.getAndUpdate(turns, (count) => count + 1), (count): SessionsShape => pool[count % 2] ?? pool[0] ?? Sessions.of({ create: () => Effect.die("empty pool"), read: () => Effect.die("empty pool"), turn: () => Effect.die("empty pool") }))
        return Sessions.of({ create: (input) => Effect.flatMap(next, (one) => one.create(input)), read: (id) => Effect.flatMap(next, (one) => one.read(id)), turn: (id, body) => Effect.flatMap(next, (one) => one.turn(id, body)) })
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
          append: (event) => Effect.catchTag(session.append(event), "SessionRefused", () => Effect.mapError(inner.turn(id, (again) => again.append(event)), (error) => error._tag === "UnknownRecord" ? new SessionRefused({ reason: "NoOpenTurn", message: error.message }) : error)),
        })),
      })),
    }),
    // It appends what a body gives it and announces it, with no start, no end, no phase and no check that the session exists.
    turnless: (): SessionsSubject => ({
      open: (core) => Effect.gen(function* () {
        const storage = yield* built(JournalStorage, inProcessJournal(), Layer.empty)
        const only = SessionId.make("the-only-session")
        return Sessions.of({
          create: () => Effect.as(Effect.ignore(storage.create({ id: only, owner: Owner.make("nobody"), format: 1 }), { log: "Debug", message: "the careless plugin keeps one session" }), only),
          read: (id) => Effect.catchTag(storage.read(id), "JournalStorageError", () => Effect.succeed({ header: { id, owner: Owner.make("nobody"), format: 1 as const }, events: [] })),
          turn: (id, body) => body({
            id,
            turn: TurnNumber.make(1),
            journal: Effect.map(storage.read(id), (journal) => journal.events),
            append: (event) => Effect.flatMap(storage.read(id), (journal) => storage.append(id, Seq.make(journal.events.length), event)).pipe(
              Effect.tap((kept) => core.publish(announced({ id, turn: TurnNumber.make(1) }, kept))),
            ),
          }),
        })
      }),
    }),
  }

  test("each careless session plugin fails the checks of what it is careless about, and between them every check", async () => {
    const failed = {
      private: await failedChecks(sessionsConformance(careless.private())),
      oneFlag: await failedChecks(sessionsConformance(careless.oneFlag())),
      pooled: await failedChecks(sessionsConformance(careless.pooled())),
      reopening: await failedChecks(sessionsConformance(careless.reopening())),
      trusting: await failedChecks(sessionsConformance(careless.trusting())),
      turnless: await failedChecks(sessionsConformance(careless.turnless())),
    }
    expect(failed.private).toEqual(["announce", "close-listener", "listener", "ordered"])
    expect(failed.oneFlag).toEqual(["isolated"])
    expect(failed.pooled).toEqual(["ordered"])
    expect(failed.reopening).toEqual(["closed-append"])
    expect(failed.trusting).toEqual(["invalid-session"])
    expect(failed.turnless).toEqual(sorted(every))
  }, 60_000)
})

describe("the memory kit", () => {
  const system = "You are a kit."
  const budgetTokens = 200
  const settings = Layer.succeed(Settings, { system })
  const subject = (name: string, layer: Layer.Layer<Memory, PluginFailure, Core | Settings>): MemorySubject =>
    ({ name, system, budgetTokens, open: (core) => built(Memory, layer, Layer.merge(onCore(core), settings)) })
  const every = ["turn-message", "pointers", "estimate", "own-records", "prefix", "fits", "over-budget", "unknown-skipped", "unknown-refused", "foreign"]

  test("has the checks its doc comment lists, and passes on the window memory plugin", async () => {
    expect(ids(memoryConformance(subject("window", windowMemory({ budgetTokens }))))).toEqual(every)
    expect(await failedChecks(memoryConformance(subject("window", windowMemory({ budgetTokens }))))).toEqual([])
  })

  /** A careless memory: what it points at, what it says the request costs, and what it writes while it builds. */
  const careless = (name: string, pick: (journal: ReadonlyArray<{ readonly seq: Seq; readonly name: string; readonly message?: { readonly text: string } }>) => ReadonlyArray<Seq>, options: { readonly count?: boolean; readonly writes?: boolean } = {}) =>
    subject(name, Layer.succeed(Memory, Memory.of({
      build: (session) => Effect.gen(function* () {
        if (options.writes === true) yield* session.append(userMessage("a note in another plugin's name"))
        const journal = yield* session.journal
        const messages = pick(journal)
        const estimatedTokens = options.count === false ? Tokens.make(0)
          : estimateRequest(system, journal.filter((event) => messages.includes(event.seq)).flatMap((event) => event.message === undefined ? [] : [event.message]))
        return { messages, estimatedTokens, budgetTokens: Tokens.make(budgetTokens) }
      }),
    })))

  /** The window memory, but it refuses every record it does not know, whoever wrote it and whatever the record says. */
  const strict = () => subject("window", Layer.effect(Memory, Effect.gen(function* () {
    const inner = Context.get(yield* Effect.orDie(Layer.build(Layer.provide(windowMemory({ budgetTokens }), Layer.merge(onCore(yield* Core), settings)))), Memory)
    const known: ReadonlyArray<string> = [...LOOP_READER.knows, windowDroppedEvent.name]
    return Memory.of({
      build: (session, step) => Effect.flatMap(session.journal, (journal) => {
        const stranger = journal.find((event) => !known.includes(event.name))
        return stranger === undefined ? inner.build(session, step) : Effect.fail(new UnknownRecord({ name: stranger.name, seq: stranger.seq, message: "this memory reads nothing it does not know" }))
      }),
    })
  })))

  test("each careless memory fails the checks of what it is careless about, and between them every check", async () => {
    // It sends every message, reads no flag and keeps to no budget.
    const everything = await failedChecks(memoryConformance(careless("everything", (journal) => journal.filter((event) => event.message !== undefined).map((event) => event.seq))))
    expect(everything).toEqual(["fits", "over-budget", "unknown-refused"])
    // It points at nothing.
    const nothing = await failedChecks(memoryConformance(careless("nothing", () => [])))
    expect(nothing).toEqual(["fits", "over-budget", "pointers", "turn-message", "unknown-refused"])
    // It points at the last three records, message or not, counts nothing, and writes a record under another plugin's name.
    const sloppy = await failedChecks(memoryConformance(careless("sloppy", (journal) => journal.slice(-3).map((event) => event.seq), { count: false, writes: true })))
    expect(sloppy).toEqual(["estimate", "fits", "over-budget", "own-records", "pointers", "prefix", "unknown-refused"])
    // It refuses records it should pass over: another plugin's, and its own that may be skipped.
    expect(await failedChecks(memoryConformance(strict()))).toEqual(["foreign", "unknown-skipped"])
    expect(sorted([...everything, ...nothing, ...sloppy, "foreign", "unknown-skipped"])).toEqual(sorted(every))
  })
})

describe("the loop kit", () => {
  const system = "You are a kit."
  type LoopLayer = Layer.Layer<Loop, PluginFailure, Core | Sessions | Memory | Settings | LanguageModel.LanguageModel>
  /** A loop with everything it runs over, on the kit's core, its model the shipped scripted one. */
  const subject = (loop: LoopLayer): LoopSubject => ({
    open: (core: CoreShape, script: LoopScript) => Effect.gen(function* () {
      const { model } = yield* scriptedModel(script)
      const below = Layer.provideMerge(sessions(), Layer.provideMerge(inProcessJournal(), onCore(core)))
      const parts = Layer.provideMerge(windowMemory({ budgetTokens: 3000 }), Layer.mergeAll(below, model, Layer.succeed(Settings, { system })))
      const services = yield* Effect.orDie(Layer.build(Layer.provideMerge(loop, parts)))
      return { loop: Context.get(services, Loop), sessions: Context.get(services, Sessions) }
    }),
  })
  const every = ["records", "deltas", "request", "closes", "busy"]

  test("has the checks its doc comment lists, and passes on the stock loop plugin", async () => {
    expect(ids(loopConformance(subject(stepLoop)))).toEqual(every)
    expect(await failedChecks(loopConformance(subject(stepLoop)))).toEqual([])
  })

  /** The stock loop's steps with one flaw: each of these asks the model, as a loop does. */
  const flawed = (flaw: "copies" | "silent" | "forgiving"): LoopLayer => Layer.effect(Loop, Effect.gen(function* () {
    const core = yield* Core
    const turns = yield* Sessions
    const memory = yield* Memory
    const model = yield* LanguageModel.LanguageModel
    const settings = yield* Settings
    const sorry: AssistantMessage = { _tag: "Assistant", text: "Sorry.", toolCalls: [] }
    return Loop.of({
      run: (input) => turns.turn(input.session, (session) => Effect.gen(function* () {
        yield* session.append(userMessage(input.message))
        const request = yield* memory.build(session, firstStep)
        const messages = yield* Effect.fromResult(resolveRequest(yield* session.journal, request))
        // "copies": what the user said is written into the stored request as well as into its own record.
        yield* session.append(requestSent(firstStep, flaw === "copies" ? `${settings.system} The user said: ${input.message}` : settings.system, request))
        // "silent": the answer's pieces are not published.
        const asked = callModel(model, settings.system, messages, (delta) => flaw === "silent" ? Effect.void : core.publish(assistantDelta(session, delta)))
        // "forgiving": a model that fails is answered for, so the turn ends as if nothing happened.
        const message = yield* (flaw === "forgiving" ? Effect.catch(asked, () => Effect.succeed(sorry)) : asked)
        yield* session.append(assistantMessage(firstStep, message))
        return replyOf(message)
      })),
    })
  }))

  test("each careless loop fails the checks of what it is careless about, and between them every check", async () => {
    const failed = {
      copies: await failedChecks(loopConformance(subject(flawed("copies")))),
      silent: await failedChecks(loopConformance(subject(flawed("silent")))),
      forgiving: await failedChecks(loopConformance(subject(flawed("forgiving")))),
      // It answers without a turn: nothing is stored, nothing is published, nothing is refused.
      turnless: await failedChecks(loopConformance(subject(Layer.succeed(Loop, Loop.of({ run: (input) => Effect.succeed({ text: input.message }) }))))),
    }
    expect(failed.copies).toEqual(["request"])
    expect(failed.silent).toEqual(["busy", "deltas"])
    expect(failed.forgiving).toEqual(["closes"])
    expect(failed.turnless).toEqual(sorted(every))
  })
})
