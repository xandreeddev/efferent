import assert from "node:assert/strict"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { assistantMessage, Core, inspectionOf, JournalStorage, journalStorageConformance, kernel, Sessions, sessionsConformance, userMessage } from "@xandreed/core/kernel"
import { callTool, flatMemory, Inbox, inbox, inProcessJournal, Memory, memoryConformance, modelAnswer, scriptedModel, sessions, webStorageJournal, windowMemory } from "@xandreed/sdk/kernel"

const system = "You are a kit."
const budgetTokens = 200
const onCore = (core) => Layer.succeed(Core, core)
/** Build a plugin's layer over the services given and take the contract it provides. */
const built = (key, layer, over) =>
  Effect.map(Effect.orDie(Layer.build(Layer.provide(layer, over))), (services) => Context.get(services, key))

/** What a browser's `localStorage` is to the web storage journal: strings by key. */
const memoryStore = () => {
  const values = new Map()
  return {
    get length() { return values.size },
    key: (index) => Array.from(values.keys())[index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}
const webOver = (store) => built(JournalStorage, webStorageJournal(store, { prefix: "consumer:" }), Layer.empty)
/** The session plugin over a store, and that store: what the sessions kit asks for. */
const sessionsOver = (core, store) => Effect.flatMap(built(JournalStorage, store, Layer.empty), (storage) =>
  Effect.map(built(Sessions, sessions(), Layer.merge(onCore(core), Layer.succeed(JournalStorage, storage))), (all) => ({ sessions: all, storage })))

const kits = {
  storage: journalStorageConformance({ open: built(JournalStorage, inProcessJournal(), Layer.empty) }),
  // A store that outlives its handle is also asked what a second handle on the same storage reads.
  webStorage: journalStorageConformance({
    open: Effect.suspend(() => webOver(memoryStore())),
    pair: Effect.suspend(() => { const store = memoryStore(); return Effect.all([webOver(store), webOver(store)], { concurrency: 1 }) }),
  }),
  sessions: sessionsConformance({ open: (core) => sessionsOver(core, inProcessJournal()) }),
  sessionsOverWebStorage: sessionsConformance({ open: (core) => sessionsOver(core, webStorageJournal(memoryStore(), { prefix: "consumer:" })) }),
  memory: memoryConformance({ name: "window", budgetTokens, open: (core) => built(Memory, windowMemory({ budgetTokens }), onCore(core)) }),
  flatMemory: memoryConformance({ name: "flat", open: (core) => built(Memory, flatMemory, onCore(core)) }),
}
/** Run a kit's checks one after another: how many ran, and what each failure said. */
const run = (checks) => Effect.runPromise(Effect.forEach(checks, (check) => Effect.map(Effect.result(check.run), (result) =>
  result._tag === "Failure" ? [`${check.id}: ${result.failure.message}`] : []), { concurrency: 1 }).pipe(
  Effect.map((failed) => ({ checks: checks.length, failed: failed.flat() })),
  Effect.timeout("60 seconds"),
))

const ran = {}
for (const [name, checks] of Object.entries(kits)) {
  ran[name] = await run(checks)
  assert.deepEqual(ran[name].failed, [], `the ${name} kit failed on its stock plugin`)
  assert.ok(ran[name].checks >= 5, `the ${name} kit ran ${ran[name].checks} checks`)
}

/** A host's own turn: open it, store the message, ask memory for the context, call the model, store the answer. */
const turnOf = (conversation, message) => Effect.scoped(Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(conversation)
  yield* session.append(userMessage(message))
  const history = yield* (yield* Memory).context(session)
  const model = yield* LanguageModel.LanguageModel
  const answer = yield* model.streamText({ prompt: Prompt.make([{ role: "system", content: system }, ...history]) }).pipe(
    Stream.tap((part) => (part.type === "error" ? Effect.fail(part.error) : Effect.void)),
    Stream.filter((part) => part.type === "text-delta"),
    Stream.map((part) => part.delta),
    Stream.mkString,
  )
  yield* session.append(assistantMessage(answer))
  return answer
}))

/** The stock parts over a model, composed as a host composes them. */
const agentOf = (model) => flatMemory.pipe(
  Layer.provideMerge(sessions()),
  Layer.provideMerge(inProcessJournal()),
  Layer.provideMerge(kernel()),
  Layer.provideMerge(model),
)

const turn = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { model, calls } = yield* scriptedModel([{ _tag: "Answers", pieces: ["Hel", "lo!"] }])
  return yield* Effect.gen(function* () {
    const sessionsOf = yield* Sessions
    const session = yield* sessionsOf.create({ owner: "consumer" })
    const reply = yield* turnOf(session, "Hello")
    const journal = yield* sessionsOf.read(session)
    const inspection = yield* Effect.fromResult(inspectionOf(journal))
    const invalid = yield* Effect.flip(sessionsOf.create({ owner: "" }))
    return { reply, invalid, state: inspection.state._tag, names: inspection.events.map((event) => event.name), stored: JSON.stringify(journal.events), calls: yield* calls }
  }).pipe(Effect.provide(agentOf(model)))
})).pipe(Effect.timeout("20 seconds")))
assert.equal(turn.reply, "Hello!")
assert.equal(turn.invalid._tag, "InvalidSession")
assert.equal(turn.state, "Free")
assert.deepEqual(turn.names, [
  "core.session.turn.started",
  "conversation.user.message",
  "conversation.assistant.message",
  "core.session.turn.ended",
])
assert.ok(!turn.stored.includes(system), "the journal holds the system text")
assert.deepEqual(turn.calls, [[{ role: "system", text: system }, { role: "user", text: "Hello" }]])

const queued = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { model } = yield* scriptedModel([{ _tag: "Answers", pieces: ["One."] }, { _tag: "Answers", pieces: ["Two."] }])
  return yield* Effect.gen(function* () {
    const session = yield* (yield* Sessions).create({ owner: "consumer" })
    const entries = yield* Effect.forEach(["First", "Second"], (message) => Effect.flatMap(Inbox, (queue) => queue.enqueue(session, message)), { concurrency: 1 })
    const replies = yield* Effect.forEach(entries, (entry) => entry.reply, { concurrency: 2 })
    return { tickets: entries.map((entry) => entry.ticket), replies }
  }).pipe(Effect.provide(inbox(turnOf).pipe(Layer.provideMerge(agentOf(model)))))
})).pipe(Effect.timeout("20 seconds")))
assert.deepEqual(queued, { tickets: [1, 2], replies: ["One.", "Two."] })

/** A host's turn with tools: Effect AI's Toolkit, offered to the model; each call run by the turn and stored with its result. */
const Add = Tool.make("add", { description: "Add two numbers.", parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }), success: Schema.Number })
const tools = Toolkit.make(Add)
const toolsLive = tools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })
const toolTurnOf = (conversation, message) => Effect.scoped(Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(conversation)
  const toolkit = yield* tools
  yield* session.append(userMessage(message))
  for (let step = 1; step <= 3; step++) {
    const history = yield* (yield* Memory).context(session)
    // The kernel's two functions for a turn's work: one reads the model's answer and stores it, the other runs a call and stores its result.
    const answer = yield* modelAnswer((yield* LanguageModel.LanguageModel).streamText({
      prompt: Prompt.make([{ role: "system", content: system }, ...history]), toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred",
    }), session)
    if (answer.toolCalls.length === 0) return answer.text
    for (const call of answer.toolCalls) {
      yield* callTool(toolkit, call, session)
    }
  }
  return "stopped"
}))
const toolTurn = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { model, calls } = yield* scriptedModel([
    { _tag: "Calls", pieces: [], calls: [{ name: "add", params: { a: 2, b: 3 } }] },
    { _tag: "Answers", pieces: ["It is 5."] },
  ])
  return yield* Effect.gen(function* () {
    const sessionsOf = yield* Sessions
    const session = yield* sessionsOf.create({ owner: "consumer" })
    const reply = yield* toolTurnOf(session, "What is 2 + 3?")
    const journal = yield* sessionsOf.read(session)
    return { reply, names: journal.events.map((event) => event.name), calls: yield* calls }
  }).pipe(Effect.provide(Layer.merge(agentOf(model), toolsLive)))
})).pipe(Effect.timeout("20 seconds")))
assert.equal(toolTurn.reply, "It is 5.")
assert.deepEqual(toolTurn.names, [
  "core.session.turn.started",
  "conversation.user.message",
  "conversation.assistant.message",
  "conversation.tool.result",
  "conversation.assistant.message",
  "core.session.turn.ended",
])
assert.deepEqual(toolTurn.calls[1], [
  { role: "system", text: system },
  { role: "user", text: "What is 2 + 3?" },
  { role: "assistant", text: "add({\"a\":2,\"b\":3})" },
  { role: "tool", text: "→ 5" },
])

/** A journal in a storage that outlives the stack that wrote it: the next stack lists it, closes the turn left open, and goes on. */
const kept = memoryStore()
const durableOf = () => sessions().pipe(Layer.provideMerge(webStorageJournal(kept, { prefix: "consumer:" })), Layer.provideMerge(kernel()))
const left = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const sessionsOf = yield* Sessions
  const session = yield* sessionsOf.create({ owner: "consumer" })
  yield* sessionsOf.turn(session, (open) => open.append(userMessage("Kept.")))
  // A writer that is gone: the start of a turn in the storage, and no end.
  kept.setItem(`consumer:${session}:4`, kept.getItem(`consumer:${session}:1`).replace('"seq":1', '"seq":4').replace(/"turn":1/g, '"turn":2'))
  return session
}).pipe(Effect.provide(durableOf()))).pipe(Effect.timeout("20 seconds")))
const resumed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const sessionsOf = yield* Sessions
  const listed = yield* sessionsOf.list
  const busy = yield* Effect.flip(sessionsOf.turn(left, () => Effect.void))
  const closed = yield* sessionsOf.recover(left)
  const turn = yield* sessionsOf.turn(left, (open) => Effect.succeed(open.turn))
  const journal = yield* sessionsOf.read(left)
  return { listed: listed.map((header) => header.id), busy: busy.reason, closed: closed._tag === "Some" ? closed.value : 0, turn, outcomes: journal.events.filter((event) => event.name === "core.session.turn.ended").map((event) => event.data.outcome._tag) }
}).pipe(Effect.provide(durableOf()))).pipe(Effect.timeout("20 seconds")))
assert.deepEqual(resumed, { listed: [left], busy: "SessionBusy", closed: 2, turn: 3, outcomes: ["Completed", "Abandoned", "Completed"] })

class Notes extends Context.Service()("consumer/Notes") {}
const notes = Layer.succeed(Notes, { of: (text) => `noted: ${text}` })
const composed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const seen = []
  const reads = Layer.effectDiscard(Effect.map(Notes, (provided) => { seen.push(provided.of("built")) }))
  yield* Layer.build(reads.pipe(Layer.provideMerge(notes)))
  return { seen }
})).pipe(Effect.timeout("20 seconds")))
assert.deepEqual(composed.seen, ["noted: built"])

console.log(`kernel ${JSON.stringify({
  runtime: typeof Bun === "undefined" ? "Node" : "Bun",
  storageKit: true,
  sessionsKit: true,
  memoryKit: true,
  hostTurn: true,
  inboxQueued: true,
  toolTurn: true,
  storeOutlives: true,
  layersComposed: true,
  checks: Object.fromEntries(Object.entries(ran).map(([name, kit]) => [name, kit.checks])),
})}`)
