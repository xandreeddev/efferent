import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { AgentLoop, definePlugin, HarnessError, Memory } from "@xandreed/core"
import type { HarnessConfig, LoopInput } from "@xandreed/core"
import { sessionSqlitePlugin } from "@xandreed/plugin-session-sqlite"
import { memoryPlugin } from "@xandreed/plugin-memory"
import { Harness } from "./harness.js"

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))
const workspace = () => { const path = mkdtempSync(join(tmpdir(), "efferent-sdk-")); directories.push(path); return path }
const loop = (id: string, run: (input: LoopInput) => Effect.Effect<{ text: string; outcome: "completed" }, HarnessError>) => definePlugin({ id, version: "1", config: Schema.Struct({}), defaults: {}, provides: [AgentLoop], layer: () => Layer.succeed(AgentLoop, { run }) })
const echo = loop("echo", (input) => input.publish({ name: "answer", runId: input.runId, data: { text: input.prompt } }).pipe(Effect.as({ text: input.prompt, outcome: "completed" as const })))
const config = (directory: string, use = "echo"): HarnessConfig => ({ version: 1, plugins: [
  { id: "store", use: sessionSqlitePlugin.id, options: { path: join(directory, "sessions.db") } },
  { id: "loop", use },
] })

describe("durable SDK sessions", () => {
  test("active turns keep their graph; later turns and new sessions use the new configuration", async () => {
    const directory = workspace()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const held = loop("held", () => Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Deferred.await(release)), Effect.as({ text: "old", outcome: "completed" as const })))
      const harness = yield* Harness.make({ workspace: directory, config: config(directory, "held"), plugins: [sessionSqlitePlugin, held, echo] })
      const session = yield* harness.create()
      const running = yield* Effect.fork(session.send("first"))
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
      const first = yield* Harness.make({ workspace: directory, config: config(directory), plugins: [sessionSqlitePlugin, echo] })
      const original = yield* first.create()
      yield* original.send("private workspace")
      const through = (yield* original.history).at(-1)!.seq
      const second = yield* Harness.make({ workspace: other, config: config(directory), plugins: [sessionSqlitePlugin, echo] })
      expect((yield* Effect.either(second.resume(original.record.id)))._tag).toBe("Left")
      expect((yield* Effect.either(second.fork(original.record.id, through)))._tag).toBe("Left")
      expect(yield* second.list).toHaveLength(0)
    })))
  })

  test("replays settled events, resumes and forks without rerunning work", async () => {
    const directory = workspace()
    const id = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: config(directory), plugins: [sessionSqlitePlugin, echo] })
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
      const harness = yield* Harness.make({ workspace: directory, config: config(directory), plugins: [sessionSqlitePlugin, echo] })
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
      const harness = yield* Harness.make({ workspace: directory, config: config(directory, "slow"), plugins: [sessionSqlitePlugin, slow] })
      const session = yield* harness.create()
      const sending = yield* Effect.fork(session.send("first"))
      yield* Effect.repeat(session.busy, { until: (busy) => busy })
      yield* session.steer("keep this")
      yield* session.interrupt
      yield* Fiber.join(sending)
      expect((yield* session.history).filter((event) => event.name === "run.cancelled")).toHaveLength(1)
      expect(yield* session.busy).toBe(false)
      return session.record.id
    })))
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const harness = yield* Harness.make({ workspace: directory, config: config(directory), plugins: [sessionSqlitePlugin, echo] })
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
      const harness = yield* Harness.make({ workspace: directory, config: config(directory, "flood"), plugins: [sessionSqlitePlugin, flood] })
      const session = yield* harness.create()
      const collector = yield* Effect.fork(session.events().pipe(Stream.filter((event) => event.name === "item"), Stream.take(1200), Stream.runCollect))
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
      return { run: (input: LoopInput) => memory.recall(input.session.workspace, input.prompt).pipe(Effect.map((entries) => ({ text: entries[0]?.text ?? "", outcome: "completed" as const }))) }
    })) })
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const first = config(directory)
      const harness = yield* Harness.make({ workspace: directory, config: first, plugins: [sessionSqlitePlugin, echo, memoryPlugin] })
      const session = yield* harness.create()
      yield* session.send("before")
      expect(yield* harness.reconfigure({ ...first, plugins: [...first.plugins!.filter((entry) => entry.id !== "loop"), { id: "loop", use: customLoop.id }, { id: "memory", use: customMemory.id }] }, [sessionSqlitePlugin, echo, customLoop, customMemory, memoryPlugin])).toBe("applied")
      yield* session.send("after")
      expect((yield* session.history).filter((event) => event.name === "run.completed").at(-1)?.data.text).toBe("custom memory")
      expect((yield* Effect.either(harness.reconfigure({ version: 1, plugins: [{ id: "bad", use: "missing" }] })))._tag).toBe("Left")
      expect(yield* harness.reconfigure((yield* harness.graph).config)).toBe("applied")
      yield* session.send("still works")
    })))
  })
})
