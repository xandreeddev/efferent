import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Order, Array as Arr, Ref } from "effect"
import {
  announced,
  assistantMessage,
  Core,
  definePlugin,
  estimateRequest,
  firstStep,
  Loop,
  loopConformance,
  makeCore,
  Memory,
  memoryConformance,
  Owner,
  replyOf,
  requestSent,
  Seq,
  SessionId,
  Sessions,
  sessionsConformance,
  Settings,
  Storage,
  storageConformance,
  Tokens,
  TurnNumber,
  userMessage,
} from "@xandreed/core/kernel"
import type { AssistantMessage, ConformanceCheck, LoopScript, LoopSubject, MemorySubject, Plugin, SessionsSubject, StorageSubject } from "@xandreed/core/kernel"
import { inMemoryStorage, sessions, stepLoop, windowMemory } from "./index.js"
import { following } from "./testing.js"

/*
 * The four contracts' kits: each passes on its stock plugin, and each of
 * its checks fails on at least one careless plugin written here, so no
 * check holds for a plugin that does not keep the promise it checks.
 */

type CoreShape = Context.Service.Shape<typeof Core>

/** The checks of a kit that fail, by the id each failure names. */
const failedChecks = (checks: ReadonlyArray<ConformanceCheck>) =>
  Effect.runPromise(Effect.forEach(checks, (check) => Effect.result(check.run).pipe(
    Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 }))
    .then((failed) => Arr.sort(Arr.dedupe(failed.flat()), Order.String))

const onCore = (core: CoreShape) => Layer.succeed(Core, core)
/** Build a plugin over the services given and take the contract it provides. */
const built = <I, S, R>(key: Context.Key<I, S>, plugin: Plugin<I, never, R>, over: Layer.Layer<R>) =>
  Effect.map(Layer.build(Layer.provide(Layer.fresh(plugin.layer), over)), (services) => Context.get(services, key))

describe("the storage kit", () => {
  const stock: StorageSubject = { open: built(Storage, inMemoryStorage(), Layer.empty) }
  const every = ["append", "conflict", "create", "missing", "read-from"]

  test("passes on the in-memory storage plugin", async () => {
    expect(storageConformance(stock)).toHaveLength(every.length)
    expect(await failedChecks(storageConformance(stock))).toEqual([])
  })

  test("fails every check on a store that keeps nothing", async () => {
    const forgetful: StorageSubject = {
      open: Effect.succeed(Storage.of({
        create: () => Effect.void,
        append: (_id, expectedSeq, event) => Effect.succeed({ seq: Seq.make(expectedSeq + 1), at: 0, ...event }),
        read: (id) => Effect.succeed({ header: { id, owner: Owner.make("nobody"), format: 1 }, events: [] }),
      })),
    }
    expect(await failedChecks(storageConformance(forgetful))).toEqual(every)
  })
})

describe("the sessions kit", () => {
  const over = (core: CoreShape) => Layer.provideMerge(inMemoryStorage().layer, onCore(core))
  const stock: SessionsSubject = { open: (core) => built(Sessions, sessions(), over(core)) }
  const every = ["announce", "busy", "close-listener", "closes", "create", "interrupt", "listener", "missing", "turn"]

  test("passes on the stock session plugin", async () => {
    expect(sessionsConformance(stock)).toHaveLength(every.length)
    expect(await failedChecks(sessionsConformance(stock))).toEqual([])
  })

  test("a session plugin that announces on a bus of its own fails every check of an announcement", async () => {
    const private_: SessionsSubject = { open: () => Effect.flatMap(makeCore(), (own) => built(Sessions, sessions(), over(own))) }
    expect(await failedChecks(sessionsConformance(private_))).toEqual(["announce", "close-listener", "listener"])
  })

  test("a session plugin that opens no turn fails every check of a turn", async () => {
    // It appends what a body gives it and announces it, with no start, no end, no phase and no check that the session exists.
    const turnless: SessionsSubject = {
      open: (core) => Effect.gen(function* () {
        const storage = yield* built(Storage, inMemoryStorage(), Layer.empty)
        const only = SessionId.make("the-only-session")
        return Sessions.of({
          create: () => Effect.as(Effect.ignore(storage.create({ id: only, owner: Owner.make("nobody"), format: 1 }), { log: "Debug", message: "the careless plugin keeps one session" }), only),
          read: (id) => Effect.catchTag(storage.read(id), "StorageError", () => Effect.succeed({ header: { id, owner: Owner.make("nobody"), format: 1 as const }, events: [] })),
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
    }
    expect(await failedChecks(sessionsConformance(turnless))).toEqual(["announce", "busy", "close-listener", "closes", "create", "interrupt", "listener", "missing", "turn"])
  })
})

describe("the memory kit", () => {
  const system = "You are a kit."
  const budgetTokens = 200
  const settings = Layer.succeed(Settings, { system })
  const subject = (plugin: Plugin<Memory, never, Core | Settings>): MemorySubject =>
    ({ name: plugin.name, system, budgetTokens, open: (core) => built(Memory, plugin, Layer.merge(onCore(core), settings)) })
  const every = ["estimate", "fits", "foreign", "over-budget", "own-records", "pointers", "prefix", "turn-message", "unknown-refused", "unknown-skipped"]

  test("passes on the window memory plugin", async () => {
    expect(memoryConformance(subject(windowMemory({ budgetTokens })))).toHaveLength(every.length)
    expect(await failedChecks(memoryConformance(subject(windowMemory({ budgetTokens }))))).toEqual([])
  })

  /** A careless memory: what it points at, what it says the request costs, and what it writes while it builds. */
  const careless = (name: string, pick: (journal: ReadonlyArray<{ readonly seq: Seq; readonly name: string; readonly message?: { readonly text: string } }>) => ReadonlyArray<Seq>, options: { readonly count?: boolean; readonly writes?: boolean } = {}) =>
    subject(definePlugin({
      name,
      provides: Memory,
      make: Effect.succeed(Memory.of({
        open: (session) => Effect.succeed({
          build: () => Effect.gen(function* () {
            if (options.writes === true) yield* session.append(userMessage("a note in another plugin's name"))
            const journal = yield* session.journal
            const messages = pick(journal)
            const estimatedTokens = options.count === false ? Tokens.make(0)
              : estimateRequest(system, journal.filter((event) => messages.includes(event.seq)).flatMap((event) => event.message === undefined ? [] : [event.message]))
            return { messages, estimatedTokens, budgetTokens: Tokens.make(budgetTokens) }
          }),
        }),
      })),
    }))

  test("each careless memory fails the checks of what it is careless about, and between them every check", async () => {
    // It sends every message, reads no flag and keeps to no budget.
    const everything = await failedChecks(memoryConformance(careless("everything", (journal) => journal.filter((event) => event.message !== undefined).map((event) => event.seq))))
    expect(everything).toEqual(["fits", "over-budget", "unknown-refused"])
    // It points at nothing.
    const nothing = await failedChecks(memoryConformance(careless("nothing", () => [])))
    expect(nothing).toEqual(["fits", "foreign", "over-budget", "pointers", "turn-message", "unknown-refused", "unknown-skipped"])
    // It points at the last three records, message or not, counts nothing, and writes a record under another plugin's name.
    const sloppy = await failedChecks(memoryConformance(careless("sloppy", (journal) => journal.slice(-3).map((event) => event.seq), { count: false, writes: true })))
    expect(sloppy).toEqual(["estimate", "fits", "over-budget", "own-records", "pointers", "prefix", "unknown-refused"])
    expect(Arr.sort(Arr.dedupe([...everything, ...nothing, ...sloppy]), Order.String)).toEqual(every)
  })
})

describe("the loop kit", () => {
  const system = "You are a kit."
  /** Everything a loop runs over, on the kit's core, with a model that follows the kit's script. */
  const parts = (core: CoreShape, script: LoopScript) => Effect.gen(function* () {
    const { model } = yield* following(script)
    const below = Layer.provideMerge(sessions().layer, Layer.provideMerge(inMemoryStorage().layer, onCore(core)))
    return Layer.provideMerge(windowMemory({ budgetTokens: 3000 }).layer, Layer.mergeAll(below, model, Layer.succeed(Settings, { system })))
  })
  const subject = (loop: () => ReturnType<typeof stepLoop>): LoopSubject => ({
    open: (core, script) => Effect.gen(function* () {
      const services = yield* Layer.build(Layer.provideMerge(Layer.fresh(loop().layer), yield* parts(core, script)))
      return { loop: Context.get(services, Loop), sessions: Context.get(services, Sessions) }
    }),
  })
  const every = ["busy", "closes", "deltas", "records", "request"]

  test("passes on the stock loop plugin", async () => {
    expect(loopConformance(subject(stepLoop))).toHaveLength(every.length)
    expect(await failedChecks(loopConformance(subject(stepLoop)))).toEqual([])
  })

  test("a loop that answers without a turn fails every check", async () => {
    const turnless = () => definePlugin({
      name: "loop",
      provides: Loop,
      make: Effect.succeed(Loop.of({ run: (input) => Effect.succeed({ text: input.message }) })),
    })
    expect(await failedChecks(loopConformance(subject(turnless)))).toEqual(every)
  })

  test("a loop that stores the answer's pieces, copies messages into its request and asks no model fails the checks of what is stored", async () => {
    // It runs inside a turn, so a failing model and a second turn are the session plugin's to handle: it never asks the model.
    const copying = () => definePlugin({
      name: "loop",
      provides: Loop,
      make: Effect.gen(function* () {
        const turns = yield* Sessions
        const memory = yield* Memory
        const seen = yield* Ref.make(0)
        return Loop.of({
          run: (input) => turns.turn(input.session, (session) => Effect.gen(function* () {
            yield* Ref.update(seen, (count) => count + 1)
            yield* session.append(userMessage(input.message))
            const request = yield* (yield* memory.open(session)).build(firstStep)
            yield* session.append(requestSent(firstStep, `${system} ${input.message}`, request))
            const message: AssistantMessage = { _tag: "Assistant", text: "Hello!", toolCalls: [] }
            yield* session.append(userMessage("Hel"))
            yield* session.append(assistantMessage(firstStep, message))
            return replyOf(message)
          })),
        })
      }),
    })
    expect(await failedChecks(loopConformance(subject(copying)))).toEqual(every)
  })
})
