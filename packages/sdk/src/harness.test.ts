import { sessionsPlugin } from "@xandreed/plugin-sessions"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import { AgentLoop, definePlugin, HarnessError, Memory, SessionLog, Sessions, SessionStore, TurnAdmission } from "@xandreed/core"
import type { HarnessConfig, LoopInput, SessionHandle, SessionLogError, SessionMissing } from "@xandreed/core"
import { sessionSqlitePlugin, SessionStoreProjectionLive } from "@xandreed/plugin-session-sqlite"
import { memoryPlugin } from "@xandreed/plugin-memory"
import { Harness } from "./harness.js"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))
const workspace = () => { const path = mkdtempSync(join(tmpdir(), "efferent-sdk-")); directories.push(path); return path }
const loop = (id: string, run: (input: LoopInput) => Effect.Effect<{ text: string; outcome: "completed" }, HarnessError>) => definePlugin({ id, version: "1", config: Schema.Struct({}), defaults: {}, provides: [AgentLoop], layer: () => Layer.succeed(AgentLoop, { run }) })
const echo = loop("echo", (input) => input.publish({ name: "answer", runId: input.runId, data: { text: input.userMessage.text } }).pipe(Effect.as({ text: input.userMessage.text, outcome: "completed" as const })))
const config = (directory: string, use = "echo"): HarnessConfig => ({ version: 1, plugins: [
  { id: "store", use: sessionSqlitePlugin.id, options: { path: join(directory, "sessions.db") } },
  { id: "session-service", use: sessionsPlugin.id, options: { ownership: { mode: "process" } } },
  { id: "loop", use },
] })

describe("durable SDK sessions", () => {
  test("active turns keep their graph; later turns and new sessions use the new configuration", async () => {
    const directory = workspace()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const held = loop("held", () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as({ text: "old", outcome: "completed" as const })))
      const harness = yield* Harness.make({ workspace: directory, config: config(directory, "held"), plugins: [sessionSqlitePlugin, sessionsPlugin, held, echo] })
      const session = yield* harness.create()
      const running = yield* Effect.forkChild(session.send("first"))
      yield* Deferred.await(entered)
      expect(yield* harness.reconfigure({ ...config(directory), profile: "updated" })).toBe("applied")
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      yield* session.send("new")
      expect((yield* session.history).filter((event) => event.name === "run.completed").map((event) => event.data.text)).toEqual(["old", "new"])
      expect((yield* harness.create()).record.profile).toBe("updated")
    })))
  })
  test("a shared store cannot resume or fork another workspace's session", async () => {
    const directory = workspace()
    const other = workspace()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const first = yield* Harness.make({ workspace: directory, config: config(directory), plugins: [sessionSqlitePlugin, sessionsPlugin, echo] })
      const original = yield* first.create()
      yield* original.send("private workspace")
      const through = (yield* original.history).at(-1)!.seq
      const second = yield* Harness.make({ workspace: other, config: config(directory), plugins: [sessionSqlitePlugin, sessionsPlugin, echo] })
      expect((yield* Effect.result(second.resume(original.record.id)))._tag).toBe("Failure")
      expect((yield* Effect.result(second.fork(original.record.id, through)))._tag).toBe("Failure")
      expect(yield* second.list).toHaveLength(0)
    })))
  })

  test("replays settled events, resumes and forks without rerunning work", async () => {
    const directory = workspace()
    const id = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: config(directory), plugins: [sessionSqlitePlugin, sessionsPlugin, echo] })
      const session = yield* harness.create()
      yield* session.send("hello")
      const trail = yield* session.history
      expect(trail.map((event) => event.seq)).toEqual(trail.map((_, index) => index))
      const fork = yield* harness.fork(session.record.id, trail.length - 1)
      yield* fork.send("branch")
      expect((yield* session.history).filter((event) => event.name === "answer")).toHaveLength(1)
      return session.record.id
    })))
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: config(directory), plugins: [sessionSqlitePlugin, sessionsPlugin, echo] })
      const session = yield* harness.resume(id)
      expect((yield* session.history).filter((event) => event.name === "answer")).toHaveLength(1)
      yield* session.send("again")
      expect((yield* session.history).filter((event) => event.name === "answer")).toHaveLength(2)
    })))
  })
  test("cancellation settles once and preserves queued input across restart", async () => {
    const directory = workspace()
    const slow = loop("slow", () => Effect.never)
    const id = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: config(directory, "slow"), plugins: [sessionSqlitePlugin, sessionsPlugin, slow] })
      const session = yield* harness.create()
      const sending = yield* Effect.forkChild(session.send("first"))
      yield* Effect.repeat(session.busy, { until: (busy) => busy })
      yield* session.steer("keep this")
      yield* session.interrupt
      yield* Fiber.join(sending)
      expect((yield* session.history).filter((event) => event.name === "run.cancelled")).toHaveLength(1)
      expect(yield* session.busy).toBe(false)
      return session.record.id
    })))
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: config(directory), plugins: [sessionSqlitePlugin, sessionsPlugin, echo] })
      const session = yield* harness.resume(id)
      expect((yield* session.pending).map((input) => input.text)).toEqual(["keep this"])
      yield* session.continue
      expect(yield* session.pending).toHaveLength(0)
    })))
  })
  test("slow subscribers recover every durable event beyond notification capacity", async () => {
    const directory = workspace()
    const flood = loop("flood", (input) => Effect.forEach(Array.from({ length: 1200 }, (_, n) => n), (n) => input.publish({ name: "item", data: { n } })).pipe(Effect.as({ text: "done", outcome: "completed" as const })))
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: config(directory, "flood"), plugins: [sessionSqlitePlugin, sessionsPlugin, flood] })
      const session = yield* harness.create()
      const collector = yield* Effect.forkChild(session.events().pipe(Stream.filter((event) => event.name === "item"), Stream.take(1200), Stream.runCollect))
      yield* session.send("go")
      const events = yield* Fiber.join(collector)
      expect(events.length).toBe(1200)
    })))
  })
  test("external loop and memory implementations replace defaults through configuration", async () => {
    const directory = workspace()
    const customMemory = definePlugin({ id: "external/memory", version: "1", config: Schema.Struct({}), defaults: {}, provides: [Memory], layer: () => Layer.succeed(Memory, {
      recall: () => Effect.succeed([{ id: "fact", workspace: directory, text: "custom memory", createdAt: 0 }]),
      remember: (workspace, text) => Effect.succeed({ id: "fact", workspace, text, createdAt: 0 }), forget: () => Effect.void,
    }) })
    const customLoop = definePlugin({ id: "external/loop", version: "1", config: Schema.Struct({}), defaults: {}, requires: [Memory], provides: [AgentLoop], layer: () => Layer.effect(AgentLoop, Effect.gen(function* () {
      const memory = yield* Memory
      return { run: (input: LoopInput) => memory.recall(input.session.workspace, input.userMessage.text).pipe(Effect.map((entries) => ({ text: entries[0]?.text ?? "", outcome: "completed" as const }))) }
    })) })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const first = config(directory)
      const harness = yield* Harness.make({ workspace: directory, config: first, plugins: [sessionSqlitePlugin, sessionsPlugin, echo, memoryPlugin] })
      const session = yield* harness.create()
      yield* session.send("before")
      expect(yield* harness.reconfigure({ ...first, plugins: [...first.plugins!.filter((entry) => entry.id !== "loop"), { id: "loop", use: customLoop.id }, { id: "memory", use: customMemory.id }] }, [sessionSqlitePlugin, sessionsPlugin, echo, customLoop, customMemory, memoryPlugin])).toBe("applied")
      yield* session.send("after")
      expect((yield* session.history).filter((event) => event.name === "run.completed").at(-1)?.data.text).toBe("custom memory")
      expect((yield* Effect.result(harness.reconfigure({ version: 1, plugins: [{ id: "bad", use: "missing" }] })))._tag).toBe("Failure")
      expect(yield* harness.reconfigure((yield* harness.graph).config)).toBe("applied")
      yield* session.send("still works")
    })))
  })

  test("resumed handles refresh claimed input before continuing and accept later work", async () => {
    const directory = workspace()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const first = yield* Harness.make({ workspace: directory, config: config(directory), plugins: [sessionSqlitePlugin, sessionsPlugin, echo] })
      const session = yield* first.create()
      yield* session.steer("shared queued input")
      const second = yield* Harness.make({ workspace: directory, config: config(directory), plugins: [sessionSqlitePlugin, sessionsPlugin, echo] })
      const resumed = yield* second.resume(session.record.id)
      expect((yield* resumed.pending).map((input) => input.text)).toEqual(["shared queued input"])
      yield* session.continue
      yield* resumed.continue
      expect(yield* resumed.pending).toEqual([])
      yield* resumed.send("later work")
      const events = yield* resumed.history
      expect(events.filter((event) => event.name === "answer").map((event) => event.data.text)).toEqual(["shared queued input", "later work"])
      expect(events.filter((event) => event.name === "run.started")).toHaveLength(2)
    })))
  })

  test("two harness instances share Sessions ownership and a rejected begin leaves input unclaimed", async () => {
    const directory = workspace()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const held = loop("held", () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as({ text: "first", outcome: "completed" as const })))
      const leased: HarnessConfig = { ...config(directory, "held"), plugins: config(directory, "held").plugins!.map((entry) => entry.id === "session-service" ? { ...entry, options: { ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } } } : entry) }
      const first = yield* Harness.make({ workspace: directory, config: leased, plugins: [sessionSqlitePlugin, sessionsPlugin, held] })
      const session = yield* first.create()
      const other = yield* Harness.make({ workspace: directory, config: { ...leased, plugins: leased.plugins!.map((entry) => entry.id === "loop" ? { ...entry, use: "echo" } : entry) }, plugins: [sessionSqlitePlugin, sessionsPlugin, echo] })
      const sending = yield* Effect.forkChild(session.send("first"))
      yield* Deferred.await(entered)
      const resumed = yield* other.resume(session.record.id)
      expect((yield* resumed.history).filter((event) => event.name === "run.cancelled")).toEqual([])
      const busy = yield* Effect.flip(resumed.send("second"))
      expect(busy.code).toBe("session.busy")
      expect((yield* resumed.pending).map((input) => input.text)).toEqual(["second"])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(sending)
      yield* resumed.continue
      const log = yield* resumed.use(SessionLog, Effect.succeed)
      const sessions = yield* resumed.use(Sessions, Effect.succeed)
      const events = yield* log.read(session.record.id, { after: 0, kinds: [], limit: Option.none() })
      expect(events.filter((event) => event.kind === "turn.started").map((event) => Option.getOrThrow(event.turn))).toEqual([1, 2])
      expect(events.filter((event) => event.kind === "turn.ended").map((event) => event.data.reason)).toEqual(["completed", "completed"])
      expect(Option.isNone((yield* sessions.get({ id: session.record.id, owner: directory })).open)).toBe(true)
      expect(events.filter((event) => event.kind === "harness.event" && Option.isSome(event.turn)).length).toBeGreaterThan(0)
    })))
  })

  test("under process ownership, a second instance neither cancels nor steals a live process's turn", async () => {
    const directory = workspace()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const held = loop("held", (input) => Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(input.publish({ name: "answer", runId: input.runId, data: { text: input.userMessage.text } })),
        Effect.as({ text: "first", outcome: "completed" as const }),
      ))
      const first = yield* Harness.make({ workspace: directory, config: config(directory, "held"), plugins: [sessionSqlitePlugin, sessionsPlugin, held] })
      const session = yield* first.create()
      const sending = yield* Effect.forkChild(session.send("first"))
      yield* Deferred.await(entered)
      const other = yield* Harness.make({ workspace: directory, config: config(directory), plugins: [sessionSqlitePlugin, sessionsPlugin, echo] })
      const resumed = yield* other.resume(session.record.id)
      expect((yield* resumed.history).filter((event) => event.name === "run.cancelled")).toEqual([])
      expect((yield* Effect.flip(resumed.send("second"))).code).toBe("session.busy")
      expect((yield* resumed.pending).map((input) => input.text)).toEqual(["second"])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(sending)
      yield* resumed.continue
      const log = yield* resumed.use(SessionLog, Effect.succeed)
      const events = yield* log.read(session.record.id, { after: 0, kinds: [], limit: Option.none() })
      expect(events.filter((event) => event.kind === "turn.ended").map((event) => [Option.getOrThrow(event.turn), event.data.reason])).toEqual([[1, "completed"], [2, "completed"]])
      expect((yield* resumed.history).filter((event) => event.name === "answer").map((event) => event.data.text)).toEqual(["first", "second"])
    })))
  })

  test("concurrent handles consume one queued input only once", async () => {
    const directory = workspace()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const held = loop("held", (input) => Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(input.publish({ name: "answer", runId: input.runId, data: { text: input.userMessage.text } })),
        Effect.as({ text: "shared", outcome: "completed" as const }),
      ))
      const leased: HarnessConfig = { ...config(directory, "held"), plugins: config(directory, "held").plugins!.map((entry) => entry.id === "session-service" ? { ...entry, options: { ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } } } : entry) }
      const first = yield* Harness.make({ workspace: directory, config: leased, plugins: [sessionSqlitePlugin, sessionsPlugin, held] })
      const session = yield* first.create()
      yield* session.steer("shared")
      const second = yield* Harness.make({ workspace: directory, config: leased, plugins: [sessionSqlitePlugin, sessionsPlugin, held] })
      const resumed = yield* second.resume(session.record.id)
      const consuming = yield* Effect.forkChild(Effect.all([session.continue, resumed.continue], { concurrency: 2 }))
      yield* Deferred.await(entered)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(consuming)
      const events = yield* resumed.history
      expect(events.filter((event) => event.name === "answer")).toHaveLength(1)
      expect(events.filter((event) => event.name === "run.started")).toHaveLength(1)
      yield* session.continue
      yield* resumed.continue
      expect(yield* session.pending).toEqual([])
      expect(yield* resumed.pending).toEqual([])
    })))
  })
})

describe("harness fork boundaries", () => {
  const forked = (use: (harness: Harness, session: SessionHandle) => Effect.Effect<void, HarnessError | SessionMissing | SessionLogError>) => {
    const directory = workspace()
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: config(directory), plugins: [sessionSqlitePlugin, sessionsPlugin, echo] })
      const session = yield* harness.create()
      yield* session.send("hello")
      yield* use(harness, session)
    })))
  }

  test("a fork cuts exactly at the requested event, not at its turn's end", () => forked((harness, session) => Effect.gen(function* () {
    const claimed = (yield* session.history).find((event) => event.name === "input.claimed")!.seq
    const atClaim = yield* harness.fork(session.record.id, claimed)
    expect((yield* atClaim.history).map((event) => `${event.seq}:${event.name}`)).toEqual(["0:input.queued", "1:input.claimed"])
  })))

  test("a fork of a fork counts the turns it inherits, so its own turns never reuse their numbers", () => forked((harness, session) => Effect.gen(function* () {
    const branch = yield* harness.fork(session.record.id, (yield* session.history).at(-1)!.seq)
    yield* branch.steer("queued only")
    const grandchild = yield* harness.fork(branch.record.id, (yield* branch.history).at(-1)!.seq)
    const log = yield* grandchild.use(SessionLog, Effect.succeed)
    expect(Option.map((yield* log.head(grandchild.record.id)).header.parent, (parent) => parent.turnAtFork)).toEqual(Option.some(1))
    yield* grandchild.send("own turn")
    const started = yield* log.read(grandchild.record.id, { after: 0, kinds: ["turn.started"], limit: Option.none() })
    expect(started.map((event) => Option.getOrNull(event.turn))).toEqual([2, 3])
  })))

  test("a fork at an inherited-only boundary keeps its turn counter and exactly one copy of its prefix", () => forked((harness, session) => Effect.gen(function* () {
    const history = yield* session.history
    const through = history.at(-1)!.seq
    const branch = yield* harness.fork(session.record.id, through)
    const grandchild = yield* harness.fork(branch.record.id, through)
    expect(yield* grandchild.history).toEqual(history.map((event) => ({ ...event, sessionId: grandchild.record.id })))
    const sessions = yield* grandchild.use(Sessions, Effect.succeed)
    expect((yield* sessions.get({ id: grandchild.record.id, owner: grandchild.record.workspace })).turns).toBe(1)
    yield* grandchild.send("own turn")
    const log = yield* grandchild.use(SessionLog, Effect.succeed)
    const started = yield* log.read(grandchild.record.id, { after: 0, kinds: ["turn.started"], limit: Option.none() })
    expect(started.map((event) => Option.getOrNull(event.turn))).toEqual([2])
    expect((yield* grandchild.history).filter((event) => event.name === "answer").map((event) => event.data.text)).toEqual(["hello", "own turn"])
  })))

  test("a fork before the first event inherits nothing, not even a grandparent's history", () => forked((harness, session) => Effect.gen(function* () {
    const branch = yield* harness.fork(session.record.id, (yield* session.history).at(-1)!.seq)
    const empty = yield* harness.fork(branch.record.id, -1)
    expect(yield* empty.history).toEqual([])
  })))
})

describe("harness turns closed elsewhere or ending", () => {
  const leased = (directory: string, use: string): HarnessConfig => ({ ...config(directory, use), plugins: config(directory, use).plugins!.map((entry) => entry.id === "session-service" ? { ...entry, options: { ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } } } : entry) })

  test("a turn cancelled from another instance still records its run's settlement", async () => {
    const directory = workspace()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const held = loop("held", (input) => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(input.publish({ name: "answer", runId: input.runId, data: {} })), Effect.as({ text: input.userMessage.text, outcome: "completed" as const })))
      const first = yield* Harness.make({ workspace: directory, config: leased(directory, "held"), plugins: [sessionSqlitePlugin, sessionsPlugin, held] })
      const session = yield* first.create()
      const sending = yield* Effect.forkChild(Effect.result(session.send("first")))
      yield* Deferred.await(entered)
      const other = yield* Harness.make({ workspace: directory, config: leased(directory, "echo"), plugins: [sessionSqlitePlugin, sessionsPlugin, echo] })
      const resumed = yield* other.resume(session.record.id)
      const sessions = yield* resumed.use(Sessions, Effect.succeed)
      const address = { id: session.record.id, owner: directory }
      expect((yield* sessions.cancel(address, (yield* sessions.get(address)).turns)).cancelled).toBe(true)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(sending))._tag).toBe("Success")
      expect(yield* session.busy).toBe(false)
      const history = yield* session.history
      expect(history.filter((event) => event.name.startsWith("run.")).map((event) => event.name)).toEqual(["run.started", "run.cancelled"])
      expect(history.filter((event) => event.name === "answer")).toEqual([])
      yield* session.send("next")
      const forked = yield* first.fork(session.record.id, (yield* session.history).at(-1)!.seq)
      expect((yield* forked.history).filter((event) => event.name === "run.completed").map((event) => event.data.text)).toEqual(["next"])
    })))
  })

  test("a remote cancellation wins over a loop that returns successfully without another write", async () => {
    const directory = workspace()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const held = loop("held", () => Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)), Effect.as({ text: "late answer", outcome: "completed" as const }),
      ))
      const first = yield* Harness.make({ workspace: directory, config: leased(directory, "held"), plugins: [sessionSqlitePlugin, sessionsPlugin, held] })
      const session = yield* first.create()
      const sending = yield* Effect.forkChild(session.send("first"))
      yield* Deferred.await(entered)
      yield* session.steer("later input")
      const other = yield* Harness.make({ workspace: directory, config: leased(directory, "echo"), plugins: [sessionSqlitePlugin, sessionsPlugin, echo] })
      const resumed = yield* other.resume(session.record.id)
      const sessions = yield* resumed.use(Sessions, Effect.succeed)
      const address = { id: session.record.id, owner: directory }
      expect((yield* sessions.cancel(address, (yield* sessions.get(address)).turns)).cancelled).toBe(true)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(sending)
      expect((yield* session.history).filter((event) => event.name.startsWith("run.")).map((event) => event.name)).toEqual(["run.started", "run.cancelled"])
      expect((yield* session.pending).map((input) => input.text)).toEqual(["later input"])
      expect(yield* session.busy).toBe(false)
      const ended = yield* sessions.read(address, { kinds: ["turn.ended"] })
      expect(ended.map((event) => event.data.reason)).toEqual(["cancelled"])
    })))
  })

  test("input submitted while a turn is ending is queued, never dropped", async () => {
    const directory = workspace()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const quick = loop("quick", (input) => Effect.succeed({ text: input.userMessage.text, outcome: "completed" as const }))
      const harness = yield* Harness.make({ workspace: directory, config: config(directory, "quick"), plugins: [sessionSqlitePlugin, sessionsPlugin, quick] })
      const session = yield* harness.create()
      const refused = yield* Ref.make<ReadonlyArray<string>>([])
      const steers = Effect.forEach(Array.from({ length: 300 }, (_, index) => index), (index) => session.steer(`steer ${index}`).pipe(
        Effect.catch((error: HarnessError) => Ref.update(refused, (all) => [...all, `${error.code}: ${error.message}`])), Effect.andThen(Effect.yieldNow)), { discard: true })
      const sends = Effect.forEach(Array.from({ length: 30 }, (_, index) => index), (index) => Effect.result(session.send(`send ${index}`)), { discard: true })
      yield* Effect.all([steers, sends], { concurrency: 2 })
      expect(yield* Ref.get(refused)).toEqual([])
      const queued = (yield* session.history).filter((event) => event.name === "input.queued" && event.data.kind === "steer")
      expect(queued.length).toBe(300)
    })))
  }, 60_000)

  test("a steer another instance's turn claimed is not begun again as a turn", async () => {
    const directory = workspace()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const admitting = yield* Deferred.make<void>()
      const admit = yield* Deferred.make<void>()
      const ran = yield* Ref.make<ReadonlyArray<string>>([])
      const steered = loop("steered", (input) => Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)), Effect.andThen(input.steering),
        Effect.flatMap((steer) => input.publish({ name: "answer", runId: input.runId, data: { text: Option.getOrElse(steer, () => "") } })),
        Effect.as({ text: "first", outcome: "completed" as const })))
      const recording = loop("recording", (input) => Ref.update(ran, (all) => [...all, input.userMessage.text]).pipe(Effect.as({ text: input.userMessage.text, outcome: "completed" as const })))
      // The second instance's admission waits, so its begin lands after the first turn claimed the steer.
      const gated = definePlugin({ id: "test/gated-admission", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [TurnAdmission], layer: () => Layer.succeed(TurnAdmission, TurnAdmission.of({
        admit: (_turn, open) => Deferred.succeed(admitting, undefined).pipe(Effect.andThen(Deferred.await(admit)), Effect.andThen(open)),
      })) })
      const first = yield* Harness.make({ workspace: directory, config: leased(directory, "steered"), plugins: [sessionSqlitePlugin, sessionsPlugin, steered] })
      const session = yield* first.create()
      const sending = yield* Effect.forkChild(session.send("first"))
      yield* Deferred.await(entered)
      yield* session.steer("shared steer")
      const secondConfig = leased(directory, "recording")
      const second = yield* Harness.make({ workspace: directory, plugins: [sessionSqlitePlugin, sessionsPlugin, recording, gated], config: {
        ...secondConfig, plugins: [...secondConfig.plugins!, { id: "gate", use: gated.id }], bindings: { [TurnAdmission.key]: "gate" },
      } })
      const resumed = yield* second.resume(session.record.id)
      expect((yield* resumed.pending).map((input) => input.text)).toEqual(["shared steer"])
      const continuing = yield* Effect.forkChild(resumed.continue)
      yield* Deferred.await(admitting)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(sending)
      yield* Deferred.succeed(admit, undefined)
      yield* Fiber.join(continuing)
      expect(yield* Ref.get(ran)).toEqual([])
      const history = yield* resumed.history
      const steer = history.find((event) => event.name === "input.queued" && event.data.text === "shared steer")!
      expect(history.filter((event) => event.name === "input.claimed" && event.data.id === steer.data.id)).toHaveLength(1)
      expect(history.filter((event) => event.name === "answer").map((event) => event.data.text)).toEqual(["shared steer"])
      expect(yield* resumed.pending).toEqual([])
    })))
  })

  test("a harness without the sessions plugin says what to add", async () => {
    const directory = workspace()
    const missing = await Effect.runPromise(Effect.scoped(Harness.make({ workspace: directory, plugins: [sessionSqlitePlugin, echo], config: { version: 1, plugins: [
      { id: "store", use: sessionSqlitePlugin.id, options: { path: join(directory, "sessions.db") } }, { id: "loop", use: "echo" },
    ] } })).pipe(Effect.flip))
    expect(missing.code).toBe("service.missing")
    expect(missing.message).toContain("sessionsPlugin")
  })

  test("a SessionStore that does not read what Sessions writes fails the turn instead of losing its events", async () => {
    const directory = workspace()
    const blind = definePlugin({ id: "test/blind-store", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, requires: [SessionLog], provides: [SessionStore], layer: () => Layer.effect(SessionStore, SessionStore.pipe(Effect.map((store) => SessionStore.of({
      ...store, read: (id, after) => store.read(id, after).pipe(Effect.map((events) => events.filter((event) => event.name !== "run.started"))),
    })))).pipe(Layer.provide(SessionStoreProjectionLive)) })
    const failed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, plugins: [sessionSqlitePlugin, sessionsPlugin, echo, blind], config: {
        ...config(directory), plugins: [...config(directory).plugins!, { id: "blind", use: blind.id }], bindings: { [SessionStore.key]: "blind" },
      } })
      const session = yield* harness.create()
      return yield* Effect.flip(session.send("hello"))
    })))
    expect(failed.message).toContain("same SessionLog")
  })
})
