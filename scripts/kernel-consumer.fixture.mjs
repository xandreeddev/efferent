// The kernel through its packed entries, as a consumer installs them: the four
// contracts' kits on the four stock plugins, one turn of an agent on the
// scripted model, and a plugin that requires a contract another provides.
// Run by verify-packages on Node and on Bun.
import assert from "node:assert/strict"
import { Context, Effect, Layer } from "effect"
import { Core, definePlugin, Loop, loopConformance, Memory, memoryConformance, Sessions, sessionsConformance, Settings, JournalStorage, journalStorageConformance } from "@xandreed/core/kernel"
import { Agent, inProcessJournal, scriptedModel, sessions, stepLoop, windowMemory } from "@xandreed/sdk/kernel"

const system = "You are a kit."
const budgetTokens = 200
const onCore = (core) => Layer.succeed(Core, core)
/** Build a plugin over the services given and take the contract it provides. */
const built = (key, plugin, over) =>
  Effect.map(Effect.orDie(Layer.build(Layer.provide(Layer.fresh(plugin.layer), over))), (services) => Context.get(services, key))

const kits = {
  storage: journalStorageConformance({ open: built(JournalStorage, inProcessJournal(), Layer.empty) }),
  sessions: sessionsConformance({ open: (core) => built(Sessions, sessions(), Layer.provideMerge(inProcessJournal().layer, onCore(core))) }),
  memory: memoryConformance({
    name: windowMemory({ budgetTokens }).name,
    system,
    budgetTokens,
    open: (core) => built(Memory, windowMemory({ budgetTokens }), Layer.merge(onCore(core), Layer.succeed(Settings, { system }))),
  }),
  loop: loopConformance({
    open: (core, script) => Effect.gen(function* () {
      const { model } = yield* scriptedModel(script)
      const below = Layer.provideMerge(sessions().layer, Layer.provideMerge(inProcessJournal().layer, onCore(core)))
      const parts = Layer.provideMerge(windowMemory({ budgetTokens: 3000 }).layer, Layer.mergeAll(below, model, Layer.succeed(Settings, { system })))
      const services = yield* Effect.orDie(Layer.build(Layer.provideMerge(Layer.fresh(stepLoop().layer), parts)))
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

const turn = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { model, calls } = yield* scriptedModel([{ _tag: "Answers", pieces: ["Hel", "lo!"] }])
  const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000 }) })
  const session = yield* agent.createSession({ owner: "consumer" })
  const reply = yield* agent.send(session, "Hello")
  const inspection = yield* agent.inspect(session)
  const refused = yield* Effect.flip(agent.send(session, "  "))
  return { reply, refused, state: inspection.state._tag, names: inspection.events.map((event) => event.name), requests: inspection.requests.length, calls: yield* calls }
})).pipe(Effect.timeout("20 seconds")))
assert.deepEqual(turn.reply, { text: "Hello!" })
assert.equal(turn.refused._tag, "AgentRefused")
assert.equal(turn.refused.reason, "EmptyMessage")
assert.equal(turn.state, "Free")
assert.deepEqual(turn.names, [
  "plugin.session.turn.started",
  "plugin.loop.user.message",
  "plugin.loop.request.sent",
  "plugin.loop.assistant.message",
  "plugin.session.turn.ended",
])
assert.equal(turn.requests, 1)
assert.deepEqual(turn.calls, [[{ role: "system", text: system }, { role: "user", text: "Hello" }]])

// A contract of the consumer's own: one extra plugin provides it, and one listed before it requires it.
class Notes extends Context.Service()("consumer/Notes") {}
const notes = () => definePlugin({ name: "notes", requires: [], provides: Notes, make: Effect.succeed({ of: (text) => `noted: ${text}` }) })
const planned = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { model } = yield* scriptedModel([{ _tag: "Answers", pieces: ["Hi."] }])
  const seen = []
  const reads = () => definePlugin({ name: "reads", requires: [Notes], make: Effect.map(Notes, (provided) => { seen.push(provided.of("built")) }) })
  const config = { model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000 }) }
  yield* Agent.define({ ...config, plugins: [reads(), notes()] })
  const refused = yield* Effect.flip(Agent.define({ ...config, plugins: [reads()] }))
  return { seen, refused: { tag: refused._tag, reason: refused.reason, plugin: refused.plugin, contract: refused.contract } }
})).pipe(Effect.timeout("20 seconds")))
assert.deepEqual(planned.seen, ["noted: built"])
assert.deepEqual(planned.refused, { tag: "PluginRefused", reason: "MissingProvider", plugin: "reads", contract: "consumer/Notes" })

console.log(`kernel ${JSON.stringify({
  runtime: typeof Bun === "undefined" ? "Node" : "Bun",
  storageKit: true,
  sessionsKit: true,
  memoryKit: true,
  loopKit: true,
  scriptedTurn: true,
  pluginsPlanned: true,
  checks: Object.fromEntries(Object.entries(ran).map(([name, kit]) => [name, kit.checks])),
})}`)
