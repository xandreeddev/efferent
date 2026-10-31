import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Option, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { mediaFromBase64 } from "../domain/media.entity.functions.js"
import { mediaHashOf } from "../domain/media-store.entity.functions.js"
import { MediaStoreError } from "../domain/media-store.entity.js"
import { MediaStore } from "../ports/media-store.port.js"
import { SessionLog } from "../ports/session-log.port.js"
import { ConversationId } from "../domain/message.entity.js"
import { RequestPartData } from "../turn/request-part.entity.js"
import { encodeRequestPart } from "../turn/request-part.entity.functions.js"
import { storedJson } from "./session-log.entity.functions.js"
import { SessionLogMemoryLive } from "./session-log.memory.adapter.js"
import { SessionLogError } from "./session-log.entity.js"
import { withMediaStore } from "./session-log-media.adapter.js"
import { sessionLogConformance } from "./session-log.conformance.js"
import { MediaEnvelope } from "./media-reference.entity.js"
import { replaceJsonAt } from "./media-reference.entity.functions.js"
import type { JsonObject, SessionDraft } from "./session-log.entity.js"
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const id = ConversationId.make("00000000-0000-4000-8000-000000000022")
const header = { id, owner: "fixture", origin: "user", createdAt: 0, meta: {}, parent: Option.none() }
const query = { after: 0, limit: Option.none<number>(), kinds: [] }
const commitOf = (events: ReadonlyArray<SessionDraft>, expect = 0) => ({ events, expect, notAfter: Option.none<number>(), state: Option.none<JsonObject>() })
const partData = Effect.gen(function* () {
  const media = yield* mediaFromBase64(png, { name: "pixel.png", alt: "exact Ω" })
  const literal = { type: "media-reference", version: 1, hash: "f".repeat(64) }
  const parameters = { image: { ...media, extra: { literal, bytes: "opaque\u0000Ω" } }, literal }
  return yield* encodeRequestPart({ _tag: "Tool", tool: { name: "lookup", description: "test", parameters, provider: Option.none() } }).pipe(Effect.flatMap(storedJson))
})
const store = (gets: string[], puts: string[]): MediaStore["Service"] => {
  const blobs = new Map<string, Uint8Array>()
  return { put: (bytes) => Effect.sync(() => { const hash = mediaHashOf(bytes); puts.push(hash); blobs.set(hash, bytes.slice()); return hash }), get: (hash) => Effect.sync(() => { gets.push(hash); const bytes = blobs.get(hash); return bytes === undefined ? Option.none() : Option.some(bytes.slice()) }) }
}

test("framework media stores physical manifest refs and hydrates exact logical data/extras/part hash", async () => {
  const gets: string[] = []
  const puts: string[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const inner = yield* SessionLog
    const wrapped = yield* withMediaStore(inner)
    yield* wrapped.create(header)
    const data = yield* partData
    const echoed = yield* wrapped.commit(id, commitOf([{ kind: "request.part", turn: Option.some(1), data }]))
    const raw = yield* inner.read(id, query)
    const hydrated = yield* wrapped.read(id, query)
    const decoded = yield* Schema.decodeUnknownEffect(RequestPartData)(hydrated[0]!.data)
    const checked = yield* encodeRequestPart(decoded.part)
    return { data, echoed, raw, hydrated, checked }
  }).pipe(Effect.provide(SessionLogMemoryLive), Effect.provideService(MediaStore, store(gets, puts))))
  expect(Object.keys(result.raw[0]!.data)).toEqual(["$efferent.media"])
  expect(JSON.stringify(result.raw)).not.toContain(png)
  expect(result.hydrated[0]!.data).toEqual(result.data)
  expect(result.echoed.events[0]!.data).toEqual(result.data)
  expect(result.data.hash).toBe(result.checked.hash)
  expect(puts).toHaveLength(1)
  expect(gets).not.toContain("f".repeat(64))
})

test("failed media put prevents the journal commit", async () => {
  const calls: number[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const inner = yield* SessionLog
    const wrapped = yield* withMediaStore({ ...inner, commit: (id, input) => { calls.push(1); return inner.commit(id, input) } })
    yield* wrapped.create(header)
    return yield* wrapped.commit(id, commitOf([{ kind: "request.part", turn: Option.some(1), data: yield* partData }])).pipe(Effect.result)
  }).pipe(Effect.provide(SessionLogMemoryLive), Effect.provideService(MediaStore, { put: () => Effect.fail(new MediaStoreError({ reason: "Unavailable", message: "blob put failed" })), get: () => Effect.succeed(Option.none()) })))
  expect(result._tag).toBe("Failure")
  expect(calls).toHaveLength(0)
})

test("cached blob ownership does not depend on a subclass slice implementation", async () => {
  class AliasingBytes extends Uint8Array { override slice(start = 0, end = this.length) { return this.subarray(start, end) } }
  const gets: number[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const inner = yield* SessionLog
    const bytes = yield* Schema.decodeUnknownEffect(Schema.Uint8ArrayFromBase64)(png)
    const shared = new AliasingBytes(bytes)
    const service: MediaStore["Service"] = { put: (bytes) => Effect.succeed(mediaHashOf(bytes)), get: () => Effect.sync(() => { gets.push(1); return Option.some(shared) }) }
    const writer = yield* withMediaStore(inner, { cacheEntries: 0 }).pipe(Effect.provideService(MediaStore, service))
    yield* writer.create(header)
    const data = yield* partData
    yield* writer.commit(id, commitOf([{ kind: "request.part", turn: Option.some(1), data }]))
    const reader = yield* withMediaStore(inner).pipe(Effect.provideService(MediaStore, service))
    yield* reader.read(id, query)
    shared.fill(0)
    return { data, events: yield* reader.read(id, query) }
  }).pipe(Effect.provide(SessionLogMemoryLive)))
  expect(result.events[0]!.data).toEqual(result.data)
  expect(gets).toHaveLength(1)
})

test("exact envelope recognition does not strip logical extras or hydrate unlisted lookalikes", async () => {
  const gets: string[] = []
  const puts: string[] = []
  const literal = { "$efferent.media": { version: 1, value: { data: { type: "media-reference", version: 1, hash: "f".repeat(64) } }, paths: [["data"]] } }
  const hybrid = { id: "input-1", entry: "turn:0", ...literal }
  const result = await Effect.runPromise(Effect.gen(function* () {
    const inner = yield* SessionLog
    const wrapped = yield* withMediaStore(inner)
    const opaque = { ...literal, image: yield* mediaFromBase64(png) }
    yield* wrapped.create({ ...header, meta: opaque })
    const copiedHead = yield* wrapped.head(id)
    yield* wrapped.commit(id, { ...commitOf([{ kind: "inbox.taken", turn: Option.some(1), data: hybrid }, { kind: "custom.media", turn: Option.none(), data: opaque }]), state: Option.some(opaque) })
    const before = yield* wrapped.read(id, query)
    const rejected = yield* wrapped.commit(id, commitOf([{ kind: "inbox.taken", turn: Option.some(1), data: literal }], 1)).pipe(Effect.result)
    return { before, rejected, copiedHead, head: yield* wrapped.head(id), opaque }
  }).pipe(Effect.provide(SessionLogMemoryLive), Effect.provideService(MediaStore, store(gets, puts))))
  expect(result.before.map((event) => event.data)).toEqual([hybrid, result.opaque])
  expect(result.copiedHead.header.meta).toEqual(result.opaque)
  expect(result.head.state).toEqual(result.opaque)
  expect(result.rejected._tag === "Failure" && result.rejected.failure._tag === "SessionLogError" && result.rejected.failure.code).toBe("store.encode")
  expect(gets).toHaveLength(0)
  expect(puts).toHaveLength(0)
})

test("noncanonical or inconsistent media-looking JSON stays inline", async () => {
  const gets: string[] = []
  const puts: string[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const image = yield* mediaFromBase64(png)
    const parameters = { wrapped: { ...image, data: "\n" + image.data }, unpadded: { ...image, data: image.data.replace(/=+$/, "") }, mismatch: { ...image, fingerprint: "0".repeat(18) } }
    const data = yield* encodeRequestPart({ _tag: "Tool", tool: { name: "test", description: "test", parameters, provider: Option.none() } }).pipe(Effect.flatMap(storedJson))
    const inner = yield* SessionLog
    const wrapped = yield* withMediaStore(inner)
    yield* wrapped.create(header)
    yield* wrapped.commit(id, commitOf([{ kind: "request.part", turn: Option.some(1), data }]))
    return { data, raw: yield* inner.read(id, query), hydrated: yield* wrapped.read(id, query) }
  }).pipe(Effect.provide(SessionLogMemoryLive), Effect.provideService(MediaStore, store(gets, puts))))
  expect(result.raw[0]!.data).toEqual(result.data)
  expect(result.hydrated[0]!.data).toEqual(result.data)
  expect(puts).toHaveLength(0)
})

test("whole commit siblings are detached before the first put can suspend", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const puts: string[] = []
    const base = store([], puts)
    const service = { ...base, put: (bytes: Uint8Array) => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(base.put(bytes))) }
    const inner = yield* SessionLog
    const wrapped = yield* withMediaStore(inner).pipe(Effect.provideService(MediaStore, service))
    yield* wrapped.create(header)
    const sibling = { value: "original" }
    const input = commitOf([{ kind: "request.part", turn: Option.some(1), data: yield* partData }, { kind: "custom", turn: Option.none(), data: sibling }])
    const work = yield* wrapped.commit(id, input).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    sibling.value = "mutated"
    yield* Deferred.succeed(release, undefined)
    return yield* Fiber.join(work)
  }).pipe(Effect.provide(SessionLogMemoryLive)))
  expect(result.events[1]!.data).toEqual({ value: "original" })
})

test("commit echo needs no get after ACK even with disabled cache", async () => {
  const gets: number[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const inner = yield* SessionLog
    const wrapped = yield* withMediaStore(inner, { cacheEntries: 0 })
    yield* wrapped.create(header)
    const data = yield* partData
    return { data, echo: yield* wrapped.commit(id, commitOf([{ kind: "request.part", turn: Option.some(1), data }])) }
  }).pipe(Effect.provide(SessionLogMemoryLive), Effect.provideService(MediaStore, { put: (bytes) => Effect.succeed(mediaHashOf(bytes)), get: () => Effect.sync(() => { gets.push(1); return Option.none() }) })))
  expect(result.echo.events[0]!.data).toEqual(result.data)
  expect(gets).toHaveLength(0)
})

test("inner commit failures retain exact identity; altered physical ACK echoes fail closed", async () => {
  const failure = new SessionLogError({ code: "store.io", message: "original uncertain ACK" })
  const result = await Effect.runPromise(Effect.gen(function* () {
    const inner = yield* SessionLog
    yield* inner.create(header)
    const bad = yield* withMediaStore({ ...inner, commit: () => Effect.fail(failure) })
    const first = yield* bad.commit(id, commitOf([{ kind: "request.part", turn: Option.some(1), data: yield* partData }])).pipe(Effect.result)
    const altered = yield* withMediaStore({ ...inner, commit: (id, input) => inner.commit(id, input).pipe(Effect.map((result) => ({ ...result, events: result.events.map((event) => ({ ...event, data: {} })) }))) })
    const second = yield* altered.commit(id, commitOf([{ kind: "request.part", turn: Option.some(1), data: yield* partData }])).pipe(Effect.result)
    return { first, second }
  }).pipe(Effect.provide(SessionLogMemoryLive), Effect.provideService(MediaStore, store([], []))))
  expect(result.first._tag === "Failure" && result.first.failure).toBe(failure)
  expect(result.second._tag === "Failure" && result.second.failure._tag === "SessionLogError" && result.second.failure.code).toBe("store.decode")
})

test("an inner backend cannot mutate the expected physical echo before verification", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const inner = yield* SessionLog
    const wrapped = yield* withMediaStore({ ...inner, commit: (id, input) => {
      const envelope = input.events[0]!.data["$efferent.media"]
      if (Schema.is(Schema.JsonObject)(envelope)) Object.assign(envelope, { version: 2 })
      return inner.commit(id, input)
    } })
    yield* wrapped.create(header)
    return yield* wrapped.commit(id, commitOf([{ kind: "request.part", turn: Option.some(1), data: yield* partData }])).pipe(Effect.result)
  }).pipe(Effect.provide(SessionLogMemoryLive), Effect.provideService(MediaStore, store([], []))))
  expect(result._tag === "Failure" && result.failure._tag === "SessionLogError" && result.failure.code).toBe("store.decode")
})

test.each([-1, NaN, Infinity, 0.5])("invalid cache budget fails typed before media IO (%p)", async (cacheBytes) => {
  const result = await Effect.runPromise(Effect.gen(function* () { return yield* withMediaStore(yield* SessionLog, { cacheBytes }).pipe(Effect.result) }).pipe(Effect.provide(SessionLogMemoryLive), Effect.provideService(MediaStore, store([], []))))
  expect(result._tag === "Failure" && result.failure.code).toBe("store.encode")
})

describe("the media decorator preserves the SessionLog contract", () => {
  const wrapped = Effect.runSync(Effect.gen(function* () { return yield* withMediaStore(yield* SessionLog) }).pipe(
    Effect.provide(SessionLogMemoryLive), Effect.provideService(MediaStore, store([], [])),
  ))
  sessionLogConformance(wrapped).map((check) => test(check.name, async () => {
    const result = await Effect.runPromise(check.run.pipe(Effect.result))
    expect(result._tag === "Failure" ? result.failure.message : "ok").toBe("ok")
  }))
})

test.each(["missing", "wrong-bytes", "invalid-metadata", "unavailable"] as const)("recognized %s media fails hard on a cold read", async (scenario) => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const inner = yield* SessionLog
    const writer = yield* withMediaStore(inner).pipe(Effect.provideService(MediaStore, store([], [])))
    yield* writer.create(header)
    yield* writer.commit(id, commitOf([{ kind: "request.part", turn: Option.some(1), data: yield* partData }]))
    const bytes = yield* Schema.decodeUnknownEffect(Schema.Uint8ArrayFromBase64)(png)
    const raw = yield* inner.read(id, query)
    const envelope = yield* Schema.decodeUnknownEffect(MediaEnvelope)(raw[0]!.data)
    const payload = envelope["$efferent.media"]
    const value = Option.getOrThrow(replaceJsonAt(payload.value, ["part", "tool", "parameters", "image", "fingerprint"], "0".repeat(18)))
    const data = scenario === "invalid-metadata" ? { "$efferent.media": { ...payload, value } } : raw[0]!.data
    const source = { ...inner, read: () => Effect.succeed([{ ...raw[0]!, data }]) }
    const reader = yield* withMediaStore(source).pipe(Effect.provideService(MediaStore, {
      put: (bytes) => Effect.succeed(mediaHashOf(bytes)),
      get: () => scenario === "unavailable" ? Effect.fail(new MediaStoreError({ reason: "Unavailable", message: "offline" }))
        : Effect.succeed(scenario === "missing" ? Option.none() : Option.some(scenario === "wrong-bytes" ? new Uint8Array([1, 2, 3]) : bytes)),
    }))
    return yield* reader.read(id, query).pipe(Effect.result)
  }).pipe(Effect.provide(SessionLogMemoryLive)))
  expect(result._tag === "Failure" && result.failure._tag === "SessionLogError" && result.failure.code).toBe(scenario === "unavailable" ? "store.io" : "store.decode")
})

test.each(["duplicate", "ancestor", "missing", "array-string", "reference-extra"] as const)("malformed %s manifest fails before blob IO", async (scenario) => {
  const gets: string[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const inner = yield* SessionLog
    const base = store(gets, [])
    const writer = yield* withMediaStore(inner).pipe(Effect.provideService(MediaStore, base))
    yield* writer.create(header)
    yield* writer.commit(id, commitOf([{ kind: "request.part", turn: Option.some(1), data: yield* partData }]))
    const raw = yield* inner.read(id, query)
    const envelope = yield* Schema.decodeUnknownEffect(MediaEnvelope)(raw[0]!.data)
    const payload = envelope["$efferent.media"]
    const path = payload.paths[0]!
    const paths = scenario === "duplicate" ? [path, path] : scenario === "ancestor" ? [["part", "data"], ["part", "data", "nested", "data"]]
      : scenario === "missing" ? [["absent", "data"]] : scenario === "array-string" ? [["items", "0", "data"]] : payload.paths
    const value = scenario === "array-string" ? { ...payload.value, items: [{ data: { type: "media-reference", version: 1, hash: "f".repeat(64) } }] }
      : scenario === "reference-extra" ? Option.getOrThrow(replaceJsonAt(payload.value, path, { type: "media-reference", version: 1, hash: "f".repeat(64), extra: true })) : payload.value
    const data = { "$efferent.media": { ...payload, value, paths } }
    const reader = yield* withMediaStore({ ...inner, read: () => Effect.succeed([{ ...raw[0]!, data }]) }).pipe(Effect.provideService(MediaStore, base))
    return yield* reader.read(id, query).pipe(Effect.result)
  }).pipe(Effect.provide(SessionLogMemoryLive)))
  expect(result._tag === "Failure" && result.failure._tag === "SessionLogError" && result.failure.code).toBe("store.decode")
  expect(gets).toHaveLength(0)
})

test("a cache hit still validates every occurrence's metadata against the bytes", async () => {
  const gets: string[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const inner = yield* SessionLog
    const base = store(gets, [])
    const writer = yield* withMediaStore(inner).pipe(Effect.provideService(MediaStore, base))
    yield* writer.create(header)
    const data = yield* partData
    yield* writer.commit(id, commitOf([1, 2].map(() => ({ kind: "request.part", turn: Option.some(1), data }))))
    const raw = yield* inner.read(id, query)
    const envelope = yield* Schema.decodeUnknownEffect(MediaEnvelope)(raw[1]!.data)
    const payload = envelope["$efferent.media"]
    const value = Option.getOrThrow(replaceJsonAt(payload.value, ["part", "tool", "parameters", "image", "bytes"], 1))
    const reader = yield* withMediaStore({ ...inner, read: () => Effect.succeed([raw[0]!, { ...raw[1]!, data: { "$efferent.media": { ...payload, value } } }]) }).pipe(Effect.provideService(MediaStore, base))
    return yield* reader.read(id, query).pipe(Effect.result)
  }).pipe(Effect.provide(SessionLogMemoryLive)))
  expect(result._tag === "Failure" && result.failure._tag === "SessionLogError" && result.failure.code).toBe("store.decode")
  expect(gets).toHaveLength(1)
})

test("the read upper bound excludes a future missing blob even if the backend ignores through", async () => {
  const gets: string[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const inner = yield* SessionLog
    const writer = yield* withMediaStore(inner).pipe(Effect.provideService(MediaStore, store([], [])))
    yield* writer.create(header)
    yield* writer.commit(id, commitOf([{ kind: "inbox.taken", turn: Option.some(1), data: { id: "input", entry: "turn:0" } }, { kind: "request.part", turn: Option.some(1), data: yield* partData }]))
    const reader = yield* withMediaStore({ ...inner, read: (id, { through: _through, ...query }) => inner.read(id, query) }).pipe(Effect.provideService(MediaStore, {
      put: (bytes) => Effect.succeed(mediaHashOf(bytes)), get: (hash) => Effect.sync(() => { gets.push(hash); return Option.none() }),
    }))
    const prefix = yield* reader.read(id, { ...query, through: 1 })
    const full = yield* reader.read(id, query).pipe(Effect.result)
    return { prefix, full }
  }).pipe(Effect.provide(SessionLogMemoryLive)))
  expect(result.prefix.map((row) => row.kind)).toEqual(["inbox.taken"])
  expect(result.full._tag === "Failure" && result.full.failure._tag === "SessionLogError" && result.full.failure.code).toBe("store.decode")
  expect(gets).toHaveLength(1)
})

test.each([
  { name: "entry bound", options: { cacheEntries: 1 }, order: [1, 2, 1], gets: 3 },
  { name: "byte bound", options: { cacheBytes: 80 }, order: [1, 2, 1], gets: 3 },
  { name: "zero byte budget", options: { cacheBytes: 0 }, order: [1, 1], gets: 2 },
  { name: "LRU touch", options: { cacheEntries: 2, cacheBytes: 1024 }, order: [1, 2, 1, 3, 2], gets: 4 },
])("cache obeys $name", async ({ options, order, gets: expected }) => {
  const gets: string[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const inner = yield* SessionLog
    const base = store(gets, [])
    const writer = yield* withMediaStore(inner, { cacheEntries: 0 }).pipe(Effect.provideService(MediaStore, base))
    yield* writer.create(header)
    // Two independent 1x1 GIF palettes plus the PNG, all recognized by Media.
    const gifs = [0, 255].map((color) => Base64.encode(new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, color, color, color, 255, 255, 255, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59])))
    const events = yield* Effect.forEach([png, ...gifs], (data) => mediaFromBase64(data).pipe(Effect.flatMap((image) => encodeRequestPart({ _tag: "Tool", tool: { name: "image", description: "test", parameters: { image }, provider: Option.none() } })), Effect.flatMap(storedJson), Effect.map((data) => ({ kind: "request.part", turn: Option.some(1), data }))))
    yield* writer.commit(id, commitOf(events))
    const reader = yield* withMediaStore(inner, options).pipe(Effect.provideService(MediaStore, base))
    return yield* Effect.forEach(order, (seq) => reader.read(id, { ...query, after: seq - 1, limit: Option.some(1) }))
  }).pipe(Effect.provide(SessionLogMemoryLive)))
  expect(result.every((rows) => rows.length === 1)).toBe(true)
  expect(gets).toHaveLength(expected)
})
