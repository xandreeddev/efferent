import { describe, expect, test } from "bun:test"
import { Cause, Context, Effect, Option, Ref, References } from "effect"
import type { Contracts } from "@xandreed/core/kernel"
import { LanguageModel } from "effect/ai"
import { Core, CoreIdle, CurrentPlugin, definePlugin, Loop, Memory, Sessions, Settings, Storage, userMessageEvent } from "@xandreed/core/kernel"
import type { PluginOf } from "@xandreed/core/kernel"
import { Agent, inMemoryStorage, sessions, stepLoop, windowMemory } from "./index.js"
import { Glossary, Summaries } from "./testing.port.js"
import { answering } from "./testing.js"

/*
 * A plugin declares what it needs, and any plugin may provide a contract
 * for another. `Agent.define` reads the declarations before it builds
 * anything: it orders the plugins by them, and refuses a set that does not
 * fit, naming the plugin and the contract.
 */

const system = "You are a friendly tutor."

/** Provides `Summaries`, a contract declared in this package's tests, and writes down that it was built. */
const summaries = (log: Ref.Ref<ReadonlyArray<string>>) => definePlugin({
  name: "summaries",
  requires: [Core],
  provides: Summaries,
  make: Effect.gen(function* () {
    const core = yield* Core
    yield* Ref.update(log, (all) => [...all, "summaries built"])
    yield* core.on(userMessageEvent, () => Ref.update(log, (all) => [...all, "summaries heard"]), { wait: true })
    return Summaries.of({ of: (messages) => Effect.succeed(`${messages.length} earlier`) })
  }),
})

/** Requires `Summaries`: what it is handed is the provider's, and it says so when a turn starts. */
const reader = (log: Ref.Ref<ReadonlyArray<string>>, name = "reader") => definePlugin({
  name,
  requires: [Core, Summaries],
  make: Effect.gen(function* () {
    const core = yield* Core
    const provided = yield* Summaries
    const line = yield* provided.of([])
    yield* Ref.update(log, (all) => [...all, `${name} built with ${line}`])
    yield* core.on(userMessageEvent, () => Ref.update(log, (all) => [...all, `${name} heard`]), { wait: true })
  }),
})

/** Needs nothing and provides nothing: it writes down that it was built, registers a listener and acquires something. */
const witness = (log: Ref.Ref<ReadonlyArray<string>>, name = "witness") => definePlugin({
  name,
  requires: [Core],
  make: Effect.gen(function* () {
    const core = yield* Core
    yield* Ref.update(log, (all) => [...all, `${name} built`])
    yield* core.on(userMessageEvent, () => Ref.update(log, (all) => [...all, `${name} heard`]), { wait: true })
    yield* Effect.addFinalizer(() => Ref.update(log, (all) => [...all, `${name} released`]))
  }),
})

/** A storage plugin that writes down that it was built and that it was released, over the stock one. */
const loggedStorage = (log: Ref.Ref<ReadonlyArray<string>>) => definePlugin({
  name: "storage",
  requires: [],
  provides: Storage,
  make: Effect.gen(function* () {
    yield* Ref.update(log, (all) => [...all, "storage built"])
    yield* Effect.addFinalizer(() => Ref.update(log, (all) => [...all, "storage released"]))
    return Context.get(yield* inMemoryStorage().build(Context.empty()), Storage)
  }),
})

/** A plugin as it is, but that it declares one contract more. */
const declaring = <I>(plugin: PluginOf<I>, contract: string): PluginOf<I> => ({ ...plugin, requires: [...plugin.requires, contract] })

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("plugins that declare what they need", () => {
  test("a consumer listed before its provider is built after it, and is handed the provider's contract", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Hi.")
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const agent = yield* Agent.define({
        model,
        system,
        storage: inMemoryStorage(),
        memory: windowMemory({ budgetTokens: 3000 }),
        plugins: [reader(log), summaries(log)],
      })
      const built = yield* Ref.get(log)
      const reply = yield* agent.send(yield* agent.createSession({ owner: "learner" }), "Hello")
      return { built, reply, heard: (yield* Ref.get(log)).slice(built.length) }
    })))
    expect(result.built).toEqual(["summaries built", "reader built with 0 earlier"])
    expect(result.reply).toEqual({ text: "Hi." })
    // Listeners registered in the order the plugins were built in, so they are heard in it.
    expect(result.heard).toEqual(["summaries heard", "reader heard"])
  })

  test("the listed order holds among plugins that do not depend on each other: only a provider listed too late is moved, to just before its consumer", async () => {
    const built = (order: (log: Ref.Ref<ReadonlyArray<string>>) => ReadonlyArray<PluginOf>) => run(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Hi.")
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }), plugins: order(log) })
      const before = (yield* Ref.get(log)).length
      yield* agent.send(yield* agent.createSession({ owner: "learner" }), "Hello")
      return { built: (yield* Ref.get(log)).slice(0, before).map((line) => line.split(" ")[0]), heard: (yield* Ref.get(log)).slice(before).map((line) => line.split(" ")[0]) }
    })))
    const listed = await built((log) => [witness(log, "first"), reader(log), witness(log, "second"), summaries(log), witness(log, "third")])
    expect(listed.built).toEqual(["first", "summaries", "reader", "second", "third"])
    expect(listed.heard).toEqual(["first", "summaries", "reader", "second", "third"])
    const inOrder = await built((log) => [summaries(log), witness(log, "first"), reader(log), witness(log, "second")])
    expect(inOrder.built).toEqual(["summaries", "first", "reader", "second"])
  })

  test("memory may require a contract an extra plugin provides: the extra is built before it", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Hi.")
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      // A memory that needs the extra's contract to be built at all. No turn runs here: the guide's test sends through such a memory.
      const noting = definePlugin({
        name: "noting",
        requires: [Summaries],
        provides: Memory,
        make: Effect.gen(function* () {
          const provided = yield* Summaries
          const line = yield* provided.of([])
          yield* Ref.update(log, (all) => [...all, `memory built with ${line}`])
          return Memory.of({ open: () => Effect.die("not opened in this test") })
        }),
      })
      const defined = yield* Effect.exit(Agent.define({ model, system, storage: inMemoryStorage(), memory: noting, plugins: [witness(log), summaries(log)] }))
      return { defined: defined._tag, log: yield* Ref.get(log) }
    })))
    expect(result.defined).toBe("Success")
    // Memory is listed before the extras; its provider is pulled in front of it, and the other extra stays behind the loop.
    expect(result.log).toEqual(["summaries built", "memory built with 0 earlier", "witness built"])
  })

  test("a plugin is handed the contracts it declared and no other, and built over services that lack one it is refused before its make runs", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const made = yield* Ref.make(0)
      const curious = definePlugin({
        name: "curious",
        requires: [Settings],
        make: Effect.gen(function* () {
          yield* Ref.update(made, (count) => count + 1)
          const settings = yield* Settings
          // Asked for by a way the compiler does not see: it is not there, because it was not declared.
          const sneaked = yield* Effect.serviceOption(Summaries)
          return yield* Effect.fail({ _tag: "Seen" as const, message: `${settings.system} ${Option.isSome(sneaked)}` })
        }),
      })
      const all = Context.make(Settings, { system: "declared" }).pipe(Context.add(Summaries, Summaries.of({ of: () => Effect.succeed("") })))
      const seen = yield* Effect.flip(curious.build(all))
      const refused = yield* Effect.flip(curious.build(Context.empty()))
      return { seen, refused, made: yield* Ref.get(made) }
    })))
    expect(result.seen).toEqual({ _tag: "Seen", message: "declared false" })
    expect(result.refused).toMatchObject({ _tag: "PluginRefused", reason: "MissingProvider", plugin: "curious", contract: Settings.key })
    expect(result.made).toBe(1)
  })

  test("a service the host has around `define` does not reach a plugin that did not declare it; the fiber's settings do", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Hi.")
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const curious = definePlugin({
        name: "curious",
        requires: [],
        make: Effect.gen(function* () {
          // Asked for by a way the compiler does not see.
          const service = yield* Effect.serviceOption(Summaries)
          const contract = yield* Effect.serviceOption(Core)
          yield* Ref.set(seen, [`the host's service: ${Option.isSome(service)}`, `a contract not declared: ${Option.isSome(contract)}`, `the log level: ${yield* References.MinimumLogLevel}`])
        }),
      })
      // The host runs `define` with a service of its own around it, and a setting of Effect's that it changed.
      yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }), plugins: [curious] }).pipe(
        Effect.provideService(Summaries, Summaries.of({ of: () => Effect.succeed("the host's") })),
        Effect.provideService(References.MinimumLogLevel, "Error"),
      )
      return yield* Ref.get(seen)
    })))
    expect(result).toEqual(["the host's service: false", "a contract not declared: false", "the log level: Error"])
  })

  test("the wait the wiring replaces an agent with is not a plugin's: it cannot be required, and is not found", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Hi.")
      const found = yield* Ref.make("not asked")
      const config = { model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }) }
      const requiring = definePlugin({ name: "requiring", requires: [CoreIdle], make: Effect.asVoid(CoreIdle) })
      const refused = yield* Effect.flip(Agent.define({ ...config, plugins: [requiring] }))
      const looking = definePlugin({ name: "looking", requires: [Core], make: Effect.flatMap(Effect.serviceOption(CoreIdle), (idle) => Ref.set(found, Option.isSome(idle) ? "found" : "not there")) })
      yield* Agent.define({ ...config, plugins: [looking] })
      return { refused, found: yield* Ref.get(found) }
    })))
    expect(result.refused).toMatchObject({ _tag: "PluginRefused", reason: "MissingProvider", plugin: "requiring", contract: CoreIdle.key })
    expect(result.found).toBe("not there")
  })

  test("what a plugin declared is kept as keys, in the order written; a Reference, which has a default, declares nothing", () => {
    expect(stepLoop().requires).toEqual([Core.key, Sessions.key, Memory.key, LanguageModel.LanguageModel.key, Settings.key])
    expect(stepLoop().provides).toBe(Loop.key)
    expect([inMemoryStorage().requires, sessions().requires, windowMemory({ budgetTokens: 3000 }).requires]).toEqual([[], [Core.key, Storage.key], [Core.key, Settings.key]])
    const named = definePlugin({ name: "named", requires: [CurrentPlugin, Core], make: Effect.flatMap(Core, () => CurrentPlugin) })
    expect(named.requires).toEqual([Core.key])
    expect(named.provides).toBeUndefined()
  })

  test("type-level: a make that uses a contract its requires does not list does not compile", () => {
    const declared = () => definePlugin({ name: "declared", requires: [Core, Summaries], make: Effect.gen(function* () { yield* Core; yield* Summaries }) })
    // @ts-expect-error `Summaries` is used and not declared: the line above differs from this one only in `requires`
    const undeclared = () => definePlugin({ name: "undeclared", requires: [Core], make: Effect.gen(function* () { yield* Core; yield* Summaries }) })
    const providing = () => definePlugin({ name: "providing", requires: [Sessions], provides: Summaries, make: Effect.map(Sessions, () => Summaries.of({ of: () => Effect.succeed("") })) })
    // @ts-expect-error nothing is declared, and `Sessions` is used: the line above differs from this one only in `requires`
    const providingUndeclared = () => definePlugin({ name: "providing", requires: [], provides: Summaries, make: Effect.map(Sessions, () => Summaries.of({ of: () => Effect.succeed("") })) })
    // The scope is not declared: a plugin that needs nothing may still acquire and register.
    const scoped = () => definePlugin({ name: "scoped", requires: [], make: Effect.addFinalizer(() => Effect.void) })
    // The documented limit: the check reads the list's own type, so a list typed loosely checks nothing. This compiles,
    // though `Summaries` is not in the list; the next test shows what becomes of it when an agent is defined.
    const loosely: Contracts = [Core]
    const unchecked = () => definePlugin({ name: "unchecked", requires: loosely, make: Effect.gen(function* () { yield* Core; yield* Summaries }) })
    // Nothing runs here: the claims are the compiler's, held by the two directives above.
    expect([declared, undeclared, providing, providingUndeclared, scoped, unchecked]).toHaveLength(6)
  })

  test("a list of contracts typed loosely is not checked by the compiler: a make that uses one the list lacks dies when the agent is defined", async () => {
    const exit = await run(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Hi.")
      const loosely: Contracts = [Core]
      const unchecked = definePlugin({ name: "unchecked", requires: loosely, make: Effect.gen(function* () { yield* Core; yield* Summaries }) })
      return yield* Effect.exit(Agent.define({ model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }), plugins: [unchecked, summaries(yield* Ref.make<ReadonlyArray<string>>([]))] }))
    })))
    // No typed failure names it: the plugin declared `Core` alone, was handed `Core` alone, and asked for more.
    const died = exit._tag === "Failure" ? Cause.pretty(exit.cause) : "defined"
    expect(died).toContain(Summaries.key)
    expect(died).not.toContain("PluginRefused")
  })
})

describe("a set of plugins that does not fit is refused when the agent is defined, before anything is built", () => {
  /** Define an agent with `extras` beside a storage, a witness and the stock parts; what it failed with, and what was built. */
  const defined = (parts: (log: Ref.Ref<ReadonlyArray<string>>) => Partial<Parameters<typeof Agent.define>[0]>) => run(Effect.scoped(Effect.gen(function* () {
    const { model } = yield* answering("Hi.")
    const log = yield* Ref.make<ReadonlyArray<string>>([])
    const chosen = parts(log)
    const outcome = yield* Effect.result(Agent.define({
      model,
      system,
      storage: loggedStorage(log),
      memory: windowMemory({ budgetTokens: 3000 }),
      ...chosen,
      plugins: [witness(log), ...(chosen.plugins ?? [])],
    }))
    return { refusal: outcome._tag === "Failure" ? outcome.failure : "defined", log: yield* Ref.get(log) }
  })))

  test("the same parts with nothing wrong are built, so the log below would show it", async () => {
    const result = await defined((log) => ({ plugins: [reader(log), summaries(log)] }))
    expect(result.refusal).toBe("defined")
    expect(result.log.filter((line) => !line.endsWith("released"))).toEqual(["storage built", "witness built", "summaries built", "reader built with 0 earlier"])
  })

  test("a plugin requires a contract nothing provides: it and the contract are named, with what to add", async () => {
    const result = await defined((log) => ({ plugins: [reader(log)] }))
    expect(result.refusal).toMatchObject({ _tag: "PluginRefused", reason: "MissingProvider", plugin: "reader", contract: Summaries.key })
    expect(result.refusal).toMatchObject({ message: `plugin reader requires ${Summaries.key}, which no plugin provides: add a plugin that provides it` })
    expect(result.log).toEqual([])
  })

  test("two plugins provide the same contract: the second and the contract are named", async () => {
    const twice = await defined((log) => ({ plugins: [summaries(log), definePlugin({ name: "other-summaries", requires: [], provides: Summaries, make: Effect.succeed(Summaries.of({ of: () => Effect.succeed("") })) })] }))
    expect(twice.refusal).toMatchObject({ _tag: "PluginRefused", reason: "DuplicateProvider", plugin: "other-summaries", contract: Summaries.key })
    expect(twice.log).toEqual([])
    // An extra that provides a slot's contract, or one the wiring provides itself, is a second provider too.
    const slot = await defined(() => ({ plugins: [definePlugin({ name: "second-memory", requires: [], provides: Memory, make: Effect.succeed(Memory.of({ open: () => Effect.die("unused") })) })] }))
    expect(slot.refusal).toMatchObject({ reason: "DuplicateProvider", plugin: "second-memory", contract: Memory.key })
    const given = await defined(() => ({ plugins: [definePlugin({ name: "second-settings", requires: [], provides: Settings, make: Effect.succeed({ system: "Mine." }) })] }))
    expect(given.refusal).toMatchObject({ reason: "DuplicateProvider", plugin: "second-settings", contract: Settings.key })
    // So is a shared part that says it provides what the wiring builds for the rebuilt ones.
    const shared = await defined(() => ({ storage: { ...inMemoryStorage(), provides: Settings.key } }))
    expect(shared.refusal).toMatchObject({ reason: "DuplicateProvider", plugin: "storage", contract: Settings.key })
    expect([...slot.log, ...given.log, ...shared.log]).toEqual([])
  })

  test("the same plugin listed twice is refused, and named: it would be built once, whatever the list says", async () => {
    const result = await defined((log) => {
      const once = witness(log, "once")
      return { plugins: [once, reader(log), summaries(log), once] }
    })
    expect(result.refusal).toMatchObject({ _tag: "PluginRefused", reason: "ListedTwice", plugin: "once", contract: "", message: "plugin once is listed twice: list it once" })
    expect(result.log).toEqual([])
    // Two plugins of one kind are two plugins.
    const twoOfAKind = await defined((log) => ({ plugins: [witness(log, "again"), witness(log, "again")] }))
    expect(twoOfAKind.refusal).toBe("defined")
  })

  test("a slot whose plugin does not provide the slot's contract leaves the agent without it: refused in the host's name", async () => {
    // What the types keep a host from writing: a loop that declares no contract, and one that declares `Loop` and builds none.
    const { provides: _dropped, ...undeclared } = stepLoop()
    const silent = await defined(() => ({ loop: undeclared }))
    expect(silent.refusal).toMatchObject({ _tag: "PluginRefused", reason: "MissingProvider", plugin: "host", contract: Loop.key })
    expect(silent.log).toEqual([])
    const empty = await defined(() => ({ loop: { ...stepLoop(), build: () => Effect.succeed(Context.makeUnsafe<Loop>(new Map())) } }))
    expect(empty.refusal).toMatchObject({ _tag: "PluginRefused", reason: "MissingProvider", plugin: "host", contract: Loop.key })
    // That one was found out after the build: what was built is released again.
    expect(empty.log).toEqual(["storage built", "witness built", "witness released", "storage released"])
  })

  test("plugins that require each other in a circle: one of them and the contract it needs are named", async () => {
    const result = await defined((log) => ({
      plugins: [
        definePlugin({ name: "summaries", requires: [Glossary], provides: Summaries, make: Effect.as(Ref.update(log, (all) => [...all, "summaries built"]), Summaries.of({ of: () => Effect.succeed("") })) }),
        definePlugin({ name: "glossary", requires: [Summaries], provides: Glossary, make: Effect.as(Ref.update(log, (all) => [...all, "glossary built"]), Glossary.of({ define: (word) => word })) }),
      ],
    }))
    expect(result.refusal).toMatchObject({ _tag: "PluginRefused", reason: "Cycle", plugin: "glossary", contract: Summaries.key })
    expect(result.refusal).toMatchObject({ message: expect.stringContaining("summaries → glossary → summaries") })
    expect(result.log).toEqual([])
  })

  test("a shared part requires a part that `with` rebuilds: storage or sessions needing the settings, memory or an extra's contract", async () => {
    const cases = [
      ["storage needs the settings", await defined(() => ({ storage: declaring(inMemoryStorage(), Settings.key) })), "storage", Settings.key],
      ["sessions needs memory", await defined(() => ({ sessions: declaring(sessions(), Memory.key) })), "session", Memory.key],
      ["sessions needs an extra's contract", await defined((log) => ({ sessions: declaring(sessions(), Summaries.key), plugins: [summaries(log)] })), "session", Summaries.key],
    ] as const
    for (const [title, result, plugin, contract] of cases) {
      expect([title, result.refusal]).toEqual([title, expect.objectContaining({ _tag: "PluginRefused", reason: "LaterContract", plugin, contract })])
      expect([title, result.log]).toEqual([title, []])
    }
  })

  test("a slot's plugin is checked like an extra one: a loop that declares a contract nothing provides is refused, and no plugin is added for it", async () => {
    const result = await defined(() => ({ loop: declaring(stepLoop(), Glossary.key) }))
    expect(result.refusal).toMatchObject({ reason: "MissingProvider", plugin: "loop", contract: Glossary.key })
    expect(result.log).toEqual([])
  })
})

describe("agent.with checks what the changed plugins declare before it builds them", () => {
  test("a set that does not fit is refused with nothing built and nothing changed: the agent works on", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Fine.")
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }) })
      const session = yield* agent.createSession({ owner: "learner" })
      const missing = yield* Effect.flip(agent.with({ plugins: [witness(log), reader(log)] }))
      const afterRefusal = yield* Ref.get(log)
      const reply = yield* agent.send(session, "Still there?")
      // The same extras with their provider listed last fit, and the agent they give takes the next turn.
      const next = yield* agent.with({ plugins: [witness(log), reader(log), summaries(log)] })
      const built = yield* Ref.get(log)
      const later = yield* next.send(session, "And now?")
      return { missing, afterRefusal, reply, built, later, heard: (yield* Ref.get(log)).slice(built.length) }
    })))
    expect(result.missing).toMatchObject({ _tag: "PluginRefused", reason: "MissingProvider", plugin: "reader", contract: Summaries.key })
    expect(result.afterRefusal).toEqual([])
    expect(result.reply).toEqual({ text: "Fine." })
    expect(result.built).toEqual(["witness built", "summaries built", "reader built with 0 earlier"])
    expect(result.later).toEqual({ text: "Fine." })
    expect(result.heard).toEqual(["witness heard", "summaries heard", "reader heard"])
  })

  test("a plugin that fails while the parts are built releases the ones built before it, in define as in with", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Fine.")
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const broken = definePlugin({ name: "broken", requires: [], make: Effect.fail({ _tag: "Broken" as const, message: "cannot be built" }) })
      // Each is defined in this test's scope, which stays open: only the wiring itself can release what it built.
      const failed = yield* Effect.flip(Agent.define({ model, system, storage: loggedStorage(log), memory: windowMemory({ budgetTokens: 3000 }), plugins: [witness(log), broken] }))
      const afterDefine = yield* Ref.get(log)
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }) })
      const replaced = yield* Effect.flip(agent.with({ plugins: [witness(log, "again"), broken] }))
      return { failed, afterDefine, replaced, afterWith: (yield* Ref.get(log)).slice(afterDefine.length), reply: yield* agent.send(yield* agent.createSession({ owner: "learner" }), "Hello") }
    })))
    expect(result.failed).toEqual({ _tag: "Broken", message: "cannot be built" })
    // What `define` built before the failure is released by `define`, the shared parts last.
    expect(result.afterDefine).toEqual(["storage built", "witness built", "witness released", "storage released"])
    expect(result.replaced).toEqual({ _tag: "Broken", message: "cannot be built" })
    expect(result.afterWith).toEqual(["again built", "again released"])
    expect(result.reply).toEqual({ text: "Fine." })
  })
})
