// The kernel through its packed entries, as a consumer installs them: the four
// contracts' kits on the four stock plugins, and one turn of an agent on the
// scripted model. Run by verify-packages on Node and on Bun.
import assert from "node:assert/strict"
import { Context, Effect, Layer } from "effect"
import { Core, Loop, loopConformance, Memory, memoryConformance, Sessions, sessionsConformance, Settings, Storage, storageConformance } from "@xandreed/core/kernel"
import { Agent, inMemoryStorage, scriptedModel, sessions, stepLoop, windowMemory } from "@xandreed/sdk/kernel"

const system = "You are a kit."
const budgetTokens = 200
const onCore = (core) => Layer.succeed(Core, core)
/** Build a plugin over the services given and take the contract it provides. */
const built = (key, plugin, over) =>
  Effect.map(Effect.orDie(Layer.build(Layer.provide(Layer.fresh(plugin.layer), over))), (services) => Context.get(services, key))

const kits = {
  storage: storageConformance({ open: built(Storage, inMemoryStorage(), Layer.empty) }),
  sessions: sessionsConformance({ open: (core) => built(Sessions, sessions(), Layer.provideMerge(inMemoryStorage().layer, onCore(core))) }),
  memory: memoryConformance({
    name: windowMemory({ budgetTokens }).name,
    system,
    budgetTokens,
    open: (core) => built(Memory, windowMemory({ budgetTokens }), Layer.merge(onCore(core), Layer.succeed(Settings, { system }))),
  }),
  loop: loopConformance({
    open: (core, script) => Effect.gen(function* () {
      const { model } = yield* scriptedModel(script)
      const below = Layer.provideMerge(sessions().layer, Layer.provideMerge(inMemoryStorage().layer, onCore(core)))
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
  const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }) })
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

console.log(`kernel ${JSON.stringify({
  runtime: typeof Bun === "undefined" ? "Node" : "Bun",
  storageKit: true,
  sessionsKit: true,
  memoryKit: true,
  loopKit: true,
  scriptedTurn: true,
  checks: Object.fromEntries(Object.entries(ran).map(([name, kit]) => [name, kit.checks])),
})}`)
