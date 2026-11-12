// The kernel through its packed entries, as a consumer installs them: the four
// contracts' kits on the stock plugins, one turn of an agent composed of
// layers on the scripted model, two messages queued with the inbox, and a
// consumer's own contract, provided by one layer and required by another.
// Run by verify-packages on Node and on Bun.
import assert from "node:assert/strict"
import { Context, Effect, Layer } from "effect"
import { Core, inspectionOf, JournalStorage, journalStorageConformance, kernel, Loop, loopConformance, Memory, memoryConformance, requestsOf, Sessions, sessionsConformance, Settings, settings } from "@xandreed/core/kernel"
import { Inbox, inbox, inProcessJournal, scriptedModel, sessions, stepLoop, windowMemory } from "@xandreed/sdk/kernel"

const system = "You are a kit."
const budgetTokens = 200
const onCore = (core) => Layer.succeed(Core, core)
/** Build a plugin's layer over the services given and take the contract it provides. */
const built = (key, layer, over) =>
  Effect.map(Effect.orDie(Layer.build(Layer.provide(layer, over))), (services) => Context.get(services, key))

const kits = {
  storage: journalStorageConformance({ open: built(JournalStorage, inProcessJournal(), Layer.empty) }),
  sessions: sessionsConformance({ open: (core) => built(Sessions, sessions(), Layer.provideMerge(inProcessJournal(), onCore(core))) }),
  memory: memoryConformance({
    name: "window",
    system,
    budgetTokens,
    open: (core) => built(Memory, windowMemory({ budgetTokens }), Layer.merge(onCore(core), Layer.succeed(Settings, { system }))),
  }),
  loop: loopConformance({
    open: (core, script) => Effect.gen(function* () {
      const { model } = yield* scriptedModel(script)
      const below = Layer.provideMerge(sessions(), Layer.provideMerge(inProcessJournal(), onCore(core)))
      const parts = Layer.provideMerge(windowMemory({ budgetTokens: 3000 }), Layer.mergeAll(below, model, Layer.succeed(Settings, { system })))
      const services = yield* Effect.orDie(Layer.build(Layer.provideMerge(stepLoop, parts)))
      return { loop: Context.get(services, Loop), sessions: Context.get(services, Sessions) }
    }),
  }),
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

/** The stock agent over a model, composed as a host composes it. */
const agentOf = (model) => stepLoop.pipe(
  Layer.provideMerge(windowMemory({ budgetTokens: 3000 })),
  Layer.provideMerge(settings({ system })),
  Layer.provideMerge(sessions()),
  Layer.provideMerge(inProcessJournal()),
  Layer.provideMerge(kernel()),
  Layer.provideMerge(model),
)

const turn = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { model, calls } = yield* scriptedModel([{ _tag: "Answers", pieces: ["Hel", "lo!"] }])
  return yield* Effect.gen(function* () {
    const sessionsOf = yield* Sessions
    const loop = yield* Loop
    const session = yield* sessionsOf.create({ owner: "consumer" })
    const reply = yield* loop.run({ session, message: "Hello" })
    const journal = yield* sessionsOf.read(session)
    const inspection = yield* Effect.fromResult(inspectionOf(journal))
    const requests = yield* Effect.fromResult(requestsOf(journal.events))
    const refused = yield* Effect.flip(loop.run({ session, message: "  " }))
    const invalid = yield* Effect.flip(sessionsOf.create({ owner: "" }))
    return { reply, refused, invalid, state: inspection.state._tag, names: inspection.events.map((event) => event.name), requests: requests.length, calls: yield* calls }
  }).pipe(Effect.provide(agentOf(model)))
})).pipe(Effect.timeout("20 seconds")))
assert.deepEqual(turn.reply, { text: "Hello!" })
assert.equal(turn.refused._tag, "EmptyMessage")
assert.equal(turn.invalid._tag, "InvalidSession")
assert.equal(turn.state, "Free")
assert.deepEqual(turn.names, [
  "core.session.turn.started",
  "plugin.loop.user.message",
  "plugin.loop.request.sent",
  "plugin.loop.assistant.message",
  "core.session.turn.ended",
])
assert.equal(turn.requests, 1)
assert.deepEqual(turn.calls, [[{ role: "system", text: system }, { role: "user", text: "Hello" }]])

const queued = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { model } = yield* scriptedModel([{ _tag: "Answers", pieces: ["One."] }, { _tag: "Answers", pieces: ["Two."] }])
  return yield* Effect.gen(function* () {
    const session = yield* (yield* Sessions).create({ owner: "consumer" })
    const entries = yield* Effect.forEach(["First", "Second"], (message) => Effect.flatMap(Inbox, (queue) => queue.enqueue(session, message)), { concurrency: 1 })
    const replies = yield* Effect.forEach(entries, (entry) => entry.reply, { concurrency: 2 })
    return { tickets: entries.map((entry) => entry.ticket), replies }
  }).pipe(Effect.provide(inbox.pipe(Layer.provideMerge(agentOf(model)))))
})).pipe(Effect.timeout("20 seconds")))
assert.deepEqual(queued, { tickets: [1, 2], replies: [{ text: "One." }, { text: "Two." }] })

// A contract of the consumer's own: one layer provides it, and one composed above it requires it.
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
  loopKit: true,
  scriptedTurn: true,
  inboxQueued: true,
  layersComposed: true,
  checks: Object.fromEntries(Object.entries(ran).map(([name, kit]) => [name, kit.checks])),
})}`)
