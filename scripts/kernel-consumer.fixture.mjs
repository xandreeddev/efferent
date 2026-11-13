import assert from "node:assert/strict"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { assistantMessage, Core, inspectionOf, JournalStorage, journalStorageConformance, kernel, Sessions, sessionsConformance, toolResult, userMessage } from "@xandreed/core/kernel"
import { flatMemory, Inbox, inbox, inProcessJournal, Memory, memoryConformance, scriptedModel, sessions, windowMemory } from "@xandreed/sdk/kernel"

const system = "You are a kit."
const budgetTokens = 200
const onCore = (core) => Layer.succeed(Core, core)
/** Build a plugin's layer over the services given and take the contract it provides. */
const built = (key, layer, over) =>
  Effect.map(Effect.orDie(Layer.build(Layer.provide(layer, over))), (services) => Context.get(services, key))

const kits = {
  storage: journalStorageConformance({ open: built(JournalStorage, inProcessJournal(), Layer.empty) }),
  sessions: sessionsConformance({ open: (core) => built(Sessions, sessions(), Layer.provideMerge(inProcessJournal(), onCore(core))) }),
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
    const parts = yield* (yield* LanguageModel.LanguageModel).streamText({
      prompt: Prompt.make([{ role: "system", content: system }, ...history]), toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred",
    }).pipe(Stream.runCollect)
    const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")
    const calls = parts.filter((part) => part.type === "tool-call")
    yield* session.append(assistantMessage(text, { toolCalls: calls }))
    if (calls.length === 0) return text
    for (const call of calls) {
      const result = yield* toolkit.handle(call.name, call.params).pipe(
        Effect.flatMap(Stream.runLast),
        Effect.map(Option.match({ onNone: () => toolResult(call, null), onSome: (last) => toolResult(call, last.encodedResult, last.isFailure) })),
        Effect.catch((error) => Effect.succeed(toolResult(call, error.message, true))),
      )
      yield* session.append(result)
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
  layersComposed: true,
  checks: Object.fromEntries(Object.entries(ran).map(([name, kit]) => [name, kit.checks])),
})}`)
