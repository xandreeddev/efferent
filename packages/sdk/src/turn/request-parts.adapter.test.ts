import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import {
  ConversationId, ConversationMemory, HarnessError, harnessCodeOf, openLogSession, resolveRequestHeader, RunId, RunOrdinal, storedJson, ToolRegistry, TurnMemory,
} from "@xandreed/core"
import type { ModelRequestHeader, ModelRequestTool, SessionLogEvent, TurnWriter } from "@xandreed/core"
import { TurnLive } from "./turn.adapter.js"
import { recordingTurnWriter } from "./testing.js"
import { encodeRequestPart } from "@xandreed/core/internal"

const tool: ModelRequestTool = { name: "lookup", description: "find a record", parameters: { type: "object", properties: {} }, provider: Option.none() }
const headerOf = (memory: TurnMemory["Service"], system = "system A", tools: ReadonlyArray<ModelRequestTool> = [tool], step = 0) => Effect.gen(function* () {
  const built = yield* memory.session.build({ run: RunOrdinal.make(0), stepContext: "none" })
  return {
    version: 1, runId: RunId.make("request-parts"), run: RunOrdinal.make(0), step, strategyVersion: "1", system,
    render: yield* memory.session.renderRecipe("none", RunOrdinal.make(0)), through: built.through,
    contextFingerprint: built.fingerprint, stableMessages: built.stableMessages, tools, toolChoice: "auto", model: Option.none(), cacheKey: Option.none(), callPolicy: Option.none(),
  } satisfies ModelRequestHeader
})
const harness = <A, E>(body: (memory: TurnMemory["Service"], stored: Ref.Ref<ReadonlyArray<SessionLogEvent>>) => Effect.Effect<A, E>, decorate: (writer: TurnWriter) => TurnWriter = (writer) => writer, history: ReadonlyArray<SessionLogEvent> = []) => Effect.scoped(Effect.gen(function* () {
  const fixture = yield* recordingTurnWriter({ runId: RunId.make("request-parts"), text: "hello", history })
  return yield* Effect.gen(function* () {
    const memory = yield* TurnMemory
    yield* memory.persistMessage
    return yield* body(memory, fixture.stored)
  }).pipe(Effect.provide(TurnLive({ turn: decorate(fixture.writer) })), Effect.provide(Layer.merge(
    Layer.succeed(ConversationMemory, { strategy: { id: "fixture", version: "1" }, open: ({ runId, log }) => openLogSession(log, { strategy: { id: "fixture", version: "1" }, render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } }, digestOnWrite: Option.none(), maintain: () => Effect.succeed({ actions: [], digest: [] }) }, { runId }) }),
    Layer.succeed(ToolRegistry, { catalog: { version: "1", recipes: [], tools: [] }, open: () => Effect.die("not used") }),
  )))
}))

test("V2 preparation atomically writes dependencies first and reuses unchanged system/tool parts", async () => {
  const batches: ReadonlyArray<string>[] = []
  const historyReads: number[] = []
  const result = await Effect.runPromise(harness((memory, stored) => Effect.gen(function* () {
    const header = yield* headerOf(memory)
    yield* memory.prepareRequest(header)
    yield* memory.prepareRequest({ ...header, step: 1 })
    yield* memory.prepareRequest({ ...header, step: 2 })
    return { events: yield* Ref.get(stored), snapshot: yield* memory.requestSnapshot }
  }), (writer) => ({ ...writer, history: (kinds) => { if (kinds.includes("request.part")) historyReads.push(1); return writer.history(kinds) }, append: (drafts) => { if (drafts.some((draft) => draft.kind === "request.prepared")) batches.push(drafts.map((draft) => draft.kind)); return writer.append(drafts) } })))
  expect(batches).toEqual([["request.part", "request.part", "request.prepared"], ["request.prepared"], ["request.prepared"]])
  expect(result.events.filter((event) => event.kind === "request.part")).toHaveLength(2)
  expect(result.snapshot.requests.map((event) => event.data.version)).toEqual([2, 2, 2])
  expect(result.snapshot.requestEvents?.map((event) => event.kind)).toEqual(["request.part", "request.part", "request.prepared", "request.prepared", "request.prepared"])
  expect(result.snapshot.entries.some((entry) => entry.body._tag === "Message" && JSON.stringify(entry).includes("request.part"))).toBe(false)
  expect(historyReads).toHaveLength(1)
})

test("concurrent same-turn preparations deduplicate equal parts and retain every header", async () => {
  const events = await Effect.runPromise(harness((memory, stored) => Effect.gen(function* () {
    const header = yield* headerOf(memory)
    yield* Effect.all([0, 1, 2].map((step) => memory.prepareRequest({ ...header, step })), { concurrency: 3 })
    return yield* Ref.get(stored)
  })))
  expect(events.filter((event) => event.kind === "request.part")).toHaveLength(2)
  expect(events.filter((event) => event.kind === "request.prepared").map((event) => event.data.step)).toEqual([0, 1, 2])
})

test("historical part sequence does not advance the child's own incremental cursor", async () => {
  const parent: SessionLogEvent = { session: ConversationId.make("00000000-0000-4000-8000-000000000099"), seq: 100, turn: Option.some(1), at: 0, kind: "request.part", data: { hash: "a".repeat(64), part: { _tag: "System", text: "unreferenced old part" } } }
  const snapshot = await Effect.runPromise(harness((memory) => Effect.gen(function* () {
    yield* memory.prepareRequest(yield* headerOf(memory))
    return yield* memory.requestSnapshot
  }), (writer) => writer, [parent]))
  expect(snapshot.requests).toHaveLength(1)
  expect(snapshot.requestEvents?.[0]).toEqual(parent)
  expect(snapshot.requestEvents?.filter((event) => event.kind === "request.prepared")).toHaveLength(1)
})

test("planner detaches nested bytes before a held header ACK", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const pending: boolean[] = []
    return yield* harness((memory, stored) => Effect.gen(function* () {
      const parameters = { type: "object", properties: {} }
      const header = { ...yield* headerOf(memory), tools: [{ ...tool, parameters }] }
      const write = yield* memory.prepareRequest(header).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      header.system = "mutated system"
      parameters.type = "string"
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(write)
      return yield* Ref.get(stored)
    }), (writer) => ({ ...writer, append: (drafts) => { if (drafts.some((draft) => draft.kind === "request.prepared")) pending.push(true); return writer.append(drafts) }, flush: Effect.suspend(() => pending.length === 1 ? Effect.sync(() => { pending.push(false) }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Deferred.await(release)), Effect.andThen(writer.flush)) : writer.flush) }))
  }))
  const parts = result.filter((event) => event.kind === "request.part")
  expect(parts).toHaveLength(2)
  expect(JSON.stringify(parts)).toContain("system A")
  expect(JSON.stringify(parts)).toContain('"type":"object"')
  expect(JSON.stringify(parts)).not.toContain("mutated system")
})

const parentSession = ConversationId.make("00000000-0000-4000-8000-000000000098")
const systemPart = encodeRequestPart({ _tag: "System", text: "system A" }).pipe(Effect.flatMap(storedJson))

test("visible ancestor parts are reused and materialized with overlapping child sequence numbers", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const parent: SessionLogEvent = { session: parentSession, seq: 100, turn: Option.some(1), kind: "request.part", at: 0, data: yield* systemPart }
    return yield* harness((memory, stored) => Effect.gen(function* () {
      yield* memory.prepareRequest(yield* headerOf(memory))
      const snapshot = yield* memory.requestSnapshot
      const header = yield* resolveRequestHeader(snapshot.requestEvents ?? snapshot.requests, snapshot.requests[0]!)
      const bare = yield* resolveRequestHeader((snapshot.requestEvents ?? []).filter((event) => event.session !== parentSession), snapshot.requests[0]!).pipe(Effect.result)
      return { header, bare, events: yield* Ref.get(stored) }
    }), (writer) => writer, [parent])
  }))
  expect(result.header.system).toBe("system A")
  expect(result.header.version).toBe(1)
  expect(result.events.filter((event) => event.kind === "request.part" && event.session !== parentSession)).toHaveLength(1)
  expect(result.bare._tag === "Failure" && Option.getOrNull(harnessCodeOf(result.bare.failure))).toBe("request.diverged")
})

test("a future part cannot repair an earlier header through the SDK snapshot", async () => {
  const writes: number[] = []
  const result = await Effect.runPromise(harness((memory) => Effect.gen(function* () {
    const first = yield* headerOf(memory)
    yield* memory.prepareRequest(first)
    const initial = yield* memory.requestSnapshot
    const selected = initial.requests[0]!
    yield* memory.prepareRequest({ ...first, step: 1 })
    const snapshot = yield* memory.requestSnapshot
    return { events: snapshot.requestEvents, old: yield* resolveRequestHeader(snapshot.requestEvents ?? [], selected).pipe(Effect.result), fresh: yield* resolveRequestHeader(snapshot.requestEvents ?? [], snapshot.requests[1]!) }
  }), (writer) => ({ ...writer, append: (drafts) => {
    if (drafts.some((draft) => draft.kind === "request.prepared")) {
      writes.push(1)
      if (writes.length === 1) return writer.append([...drafts.filter((draft) => draft.kind === "request.prepared"), ...drafts.filter((draft) => draft.kind !== "request.prepared")])
    }
    return writer.append(drafts)
  } })))
  expect(result.events?.map((event) => event.kind)).toEqual(["request.prepared", "request.part", "request.part", "request.prepared"])
  expect(result.old._tag === "Failure" && Option.getOrNull(harnessCodeOf(result.old.failure))).toBe("request.diverged")
  expect(result.fresh.system).toBe("system A")
})

test("write-side reuse rejects every conflicting occurrence without masking corruption as request.encode", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const data = yield* systemPart
    const prior: SessionLogEvent = { session: parentSession, seq: 100, turn: Option.some(1), kind: "request.part", at: 0, data }
    const bad: SessionLogEvent = { ...prior, seq: 101, data: { ...data, part: { _tag: "System", text: "tampered" } } }
    return yield* harness((memory, stored) => Effect.gen(function* () {
      const result = yield* memory.prepareRequest(yield* headerOf(memory)).pipe(Effect.result)
      return { result, headers: (yield* Ref.get(stored)).filter((event) => event.kind === "request.prepared") }
    }), (writer) => writer, [prior, bad])
  }))
  expect(result.result._tag === "Failure" && Option.getOrNull(harnessCodeOf(result.result.failure))).toBe("request.diverged")
  expect(result.headers).toHaveLength(0)
})

test("unreferenced damaged part bodies stay opaque to preparation and resolution", async () => {
  const broken: SessionLogEvent = { session: parentSession, seq: 100, turn: Option.some(1), kind: "request.part", at: 0, data: { hash: "b".repeat(64), part: { _tag: "not-a-part" } } }
  const header = await Effect.runPromise(harness((memory) => Effect.gen(function* () {
    yield* memory.prepareRequest(yield* headerOf(memory))
    const snapshot = yield* memory.requestSnapshot
    return yield* resolveRequestHeader(snapshot.requestEvents ?? [], snapshot.requests[0]!)
  }), (writer) => writer, [broken]))
  expect(header.system).toBe("system A")
})

test("an uncertain append ACK retains the original error and later refresh reuses committed parts", async () => {
  const failure = new HarnessError({ code: "memory.log", message: "request batch committed without ACK" })
  const batches: ReadonlyArray<string>[] = []
  const result = await Effect.runPromise(harness((memory, stored) => Effect.gen(function* () {
    const header = yield* headerOf(memory)
    const first = yield* memory.prepareRequest(header).pipe(Effect.result)
    yield* memory.prepareRequest({ ...header, step: 1 })
    return { first, events: yield* Ref.get(stored), snapshot: yield* memory.requestSnapshot }
  }), (writer) => ({ ...writer, append: (drafts) => {
    if (drafts.some((draft) => draft.kind === "request.prepared")) {
      batches.push(drafts.map((draft) => draft.kind))
      if (batches.length === 1) return writer.append(drafts).pipe(Effect.andThen(Effect.fail(failure)))
    }
    return writer.append(drafts)
  } })))
  expect(result.first._tag === "Failure" && result.first.failure).toBe(failure)
  expect(batches).toEqual([["request.part", "request.part", "request.prepared"], ["request.prepared"]])
  expect(result.events.filter((event) => event.kind === "request.part")).toHaveLength(2)
  expect(result.snapshot.requestEvents?.map((event) => [event.session, event.seq])).toEqual(result.events.filter((event) => event.kind === "request.part" || event.kind === "request.prepared").map((event) => [event.session, event.seq]))
})

test("a failed flush releases serialization and preserves the original writer error", async () => {
  const failure = new HarnessError({ code: "memory.log", message: "request flush failed" })
  const writes: number[] = []
  const failed: number[] = []
  const result = await Effect.runPromise(harness((memory, stored) => Effect.gen(function* () {
    const header = yield* headerOf(memory)
    const first = yield* memory.prepareRequest(header).pipe(Effect.result)
    yield* memory.prepareRequest({ ...header, step: 1 })
    return { first, events: yield* Ref.get(stored) }
  }), (writer) => ({ ...writer, append: (drafts) => { if (drafts.some((draft) => draft.kind === "request.prepared")) writes.push(1); return writer.append(drafts) }, flush: Effect.suspend(() => {
    if (writes.length === 1 && failed.length === 0) { failed.push(1); return Effect.fail(failure) }
    return writer.flush
  }) })))
  expect(result.first._tag === "Failure" && result.first.failure).toBe(failure)
  expect(result.events.filter((event) => event.kind === "request.part")).toHaveLength(2)
  expect(result.events.filter((event) => event.kind === "request.prepared")).toHaveLength(2)
})

test("interruption during a held ACK releases the gate and a waiting preparation reuses actual rows", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const writes: number[] = []
    const held: number[] = []
    return yield* harness((memory, stored) => Effect.gen(function* () {
      const header = yield* headerOf(memory)
      const first = yield* memory.prepareRequest(header).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const waiting = yield* memory.prepareRequest({ ...header, step: 1 }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(writes).toHaveLength(1)
      yield* Fiber.interrupt(first)
      yield* Fiber.join(waiting)
      return yield* Ref.get(stored)
    }), (writer) => ({ ...writer, append: (drafts) => { if (drafts.some((draft) => draft.kind === "request.prepared")) writes.push(1); return writer.append(drafts) }, flush: Effect.suspend(() => {
      if (writes.length === 1 && held.length === 0) { held.push(1); return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) }
      return writer.flush
    }) }))
  }))
  expect(result.filter((event) => event.kind === "request.part")).toHaveLength(2)
  expect(result.filter((event) => event.kind === "request.prepared")).toHaveLength(2)
})

test("caller codec errors map to request.encode before any protocol write", async () => {
  const result = await Effect.runPromise(harness((memory, stored) => Effect.gen(function* () {
    const header = yield* headerOf(memory)
    const result = yield* memory.prepareRequest({ ...header, tools: [{ ...tool, parameters: { invalid: BigInt(1) } }] }).pipe(Effect.result)
    return { result, writes: (yield* Ref.get(stored)).filter((event) => event.kind === "request.part" || event.kind === "request.prepared") }
  })))
  expect(result.result._tag === "Failure" && Option.getOrNull(harnessCodeOf(result.result.failure))).toBe("request.encode")
  expect(result.writes).toHaveLength(0)
})

test("tool reorder and repeated references reuse parts while changed declarations add only changed content", async () => {
  const result = await Effect.runPromise(harness((memory, stored) => Effect.gen(function* () {
    const other = { ...tool, name: "other" }
    const first = yield* headerOf(memory, "system A", [tool, other])
    yield* memory.prepareRequest(first)
    yield* memory.prepareRequest({ ...first, step: 1, tools: [other, tool] })
    yield* memory.prepareRequest({ ...first, step: 2, tools: [tool, tool] })
    yield* memory.prepareRequest({ ...first, step: 3, tools: [{ ...tool, description: "changed" }, other] })
    yield* memory.prepareRequest({ ...first, step: 4, system: "system B" })
    const snapshot = yield* memory.requestSnapshot
    return { events: yield* Ref.get(stored), repeated: yield* resolveRequestHeader(snapshot.requestEvents ?? [], snapshot.requests[2]!) }
  })))
  const headers = result.events.filter((event) => event.kind === "request.prepared")
  const first = Array.isArray(headers[0]!.data.tools) ? headers[0]!.data.tools : []
  expect(result.events.filter((event) => event.kind === "request.part")).toHaveLength(5)
  expect(headers[1]!.data.tools).toEqual([...first].reverse())
  expect(headers[2]!.data.tools).toEqual([first[0], first[0]])
  expect(result.repeated.tools).toEqual([tool, tool])
  expect(result.repeated.version).toBe(1)
})
