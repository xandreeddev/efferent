import { expect, test } from "bun:test"
import { Readable, Writable } from "node:stream"
import { Context, Effect, Fiber, Layer, MutableRef, Option, Result, Stream } from "effect"
import { ConversationId, RunId } from "@xandreed/core"
import fc from "fast-check"
import { ProcessPeer } from "./ports/process-peer.port.js"
import { processPeerConformance } from "./process-peer.conformance.js"
import { ProcessRequestId } from "./process-protocol.entity.js"
import type { ProcessEvent } from "./process-protocol.entity.js"
import { StdioPeerLive } from "./stdio-peer.adapter.js"
import { stdioPeerSubject } from "./stdio-peer.testing.js"

const bytes = (text: string) => new TextEncoder().encode(text)
const hello = (id = "one"): ProcessEvent => ({ _tag: "hello", requestId: ProcessRequestId.make(id), protocolVersion: 1 })
const command = '{"_tag":"ping","requestId":"one"}'
const eventually = <A>(read: Effect.Effect<A>, holds: (value: A) => boolean, tries = 500): Effect.Effect<A> =>
  read.pipe(Effect.flatMap((value) => holds(value) || tries <= 0 ? Effect.succeed(value)
    : Effect.yieldNow.pipe(Effect.andThen(Effect.suspend(() => eventually(read, holds, tries - 1))))))

processPeerConformance(stdioPeerSubject).forEach((entry) => test(entry.name, async () => {
  await Effect.runPromise(entry.run)
}))

test("arbitrary byte splits preserve a command and CRLF at the exact frame limit", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 15 }), { minLength: 1, maxLength: 30 }), async (sizes) => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const fixture = yield* stdioPeerSubject.open({ maxFrameBytes: bytes(command).byteLength, readChunkBytes: 3 })
      const data = bytes(`${command}\r\n${command}\n`)
      const boundaries = sizes.reduce<ReadonlyArray<number>>((all, size) => [...all, Math.min(data.length, (all[all.length - 1] ?? 0) + size)], [0])
      const slices = boundaries.slice(0, -1).map((start, index) => data.subarray(start, boundaries[index + 1]))
      yield* Effect.forEach([...slices, data.subarray(boundaries[boundaries.length - 1])], fixture.feed, { concurrency: 1 })
      yield* fixture.finishInput
      const received = yield* Stream.runCollect(fixture.peer.commands)
      expect(received.map((value) => value.requestId)).toEqual([ProcessRequestId.make("one"), ProcessRequestId.make("one")])
    })))
  }), { numRuns: 60 })
})

test("UTF-8 can cross every native byte boundary", async () => {
  const text = '{"_tag":"answer","requestId":"one","parent":{"id":"10000000-0000-4000-8000-000000000001","owner":"host"},"taskId":"10000000-0000-4000-8000-000000000002","questionId":"question","text":"hi 😀 café"}\n'
  // The protocol codec, rather than a lossy replacement decoder, decides validity.
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const fixture = yield* stdioPeerSubject.open({ readChunkBytes: 1 })
    yield* fixture.feed(bytes(text))
    yield* fixture.finishInput
    return yield* Effect.result(Stream.runCollect(fixture.peer.commands))
  })))
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isSuccess(result)) expect(result.success[0]?._tag).toBe("answer")
})

test("rejects BOM on the first or a later frame", async () => {
  await Effect.runPromise(Effect.forEach([`\ufeff${command}\n`, `${command}\n\ufeff${command}\n`], (text) => Effect.scoped(Effect.gen(function*() {
    const fixture = yield* stdioPeerSubject.open({ readChunkBytes: 1 })
    yield* fixture.feed(bytes(text))
    yield* fixture.finishInput
    const result = yield* Effect.result(Stream.runDrain(fixture.peer.commands))
    expect(Result.isFailure(result) && result.failure.reason).toBe("InvalidFrame")
  })), { concurrency: 1 }))
})

test("accepted writes survive caller interruption and keep later writers unencoded", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const fixture = yield* stdioPeerSubject.open({ holdWrites: true, maxPendingWrites: 2 })
    const first = yield* fixture.peer.send(hello()).pipe(Effect.forkScoped)
    expect((yield* eventually(fixture.writes, (all) => all.length === 1)).length).toBe(1)
    const reads = MutableRef.make(0)
    const secondEvent: ProcessEvent = { _tag: "hello", get requestId() { reads.current += 1; return ProcessRequestId.make("second") }, protocolVersion: 1 }
    const second = yield* fixture.peer.send(secondEvent).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    const rejectedEvent: ProcessEvent = { _tag: "hello", get requestId() { reads.current += 1; return ProcessRequestId.make("excess") }, protocolVersion: 1 }
    const rejected = yield* Effect.result(fixture.peer.send(rejectedEvent))
    expect(Result.isFailure(rejected) && rejected.failure.reason).toBe("Capacity")
    expect(reads.current).toBe(0)
    yield* Fiber.interrupt(first)
    const flush = yield* fixture.peer.flush.pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    expect(flush.pollUnsafe()).toBeUndefined()
    yield* fixture.releaseWrites
    yield* Fiber.join(second)
    yield* Fiber.join(flush)
    expect(reads.current).toBeGreaterThan(0)
    expect((yield* fixture.writes).length).toBe(2)
  })))
})

class ManualWriter extends Writable {
  readonly callback = MutableRef.make(Option.none<(error?: Error | null) => void>())
  readonly sent = MutableRef.make<ReadonlyArray<Uint8Array>>([])
  override write(data: Uint8Array | string, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
    this.sent.current = [...this.sent.current, typeof data === "string" ? bytes(data) : new Uint8Array(data)]
    this.callback.current = Option.fromNullishOr(typeof encoding === "function" ? encoding : callback)
    return false
  }
  acknowledge() { Option.map(this.callback.current, (callback) => callback()) }
}

test("callback and drain are both required, in either order", async () => {
  await Effect.runPromise(Effect.forEach(["callback-first", "drain-first"], (order) => Effect.scoped(Effect.gen(function*() {
    const input = new Readable({ read() {} })
    const output = new ManualWriter()
    yield* Effect.addFinalizer(() => Effect.sync(() => { input.destroy(); output.destroy() }))
    const peer = Context.get(yield* Layer.build(StdioPeerLive({ input, output })), ProcessPeer)
    const send = yield* peer.send(hello()).pipe(Effect.forkScoped)
    expect((yield* eventually(Effect.sync(() => output.sent.current), (all) => all.length > 0)).length).toBe(1)
    if (order === "callback-first") output.acknowledge()
    else output.emit("drain")
    yield* Effect.yieldNow
    expect(send.pollUnsafe()).toBeUndefined()
    if (order === "callback-first") output.emit("drain")
    else output.acknowledge()
    yield* Fiber.join(send)
    yield* peer.flush
  })), { concurrency: 1 }))
})

test("flush includes accepted writers still waiting for serialization", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const input = new Readable({ read() {} })
    const output = new ManualWriter()
    yield* Effect.addFinalizer(() => Effect.sync(() => { input.destroy(); output.destroy() }))
    const peer = Context.get(yield* Layer.build(StdioPeerLive({ input, output })), ProcessPeer)
    const first = yield* peer.send(hello()).pipe(Effect.forkScoped)
    yield* eventually(Effect.sync(() => output.sent.current), (all) => all.length > 0)
    const second = yield* peer.send(hello("two")).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    const flush = yield* peer.flush.pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    output.acknowledge()
    output.emit("drain")
    yield* Fiber.join(first)
    expect((yield* eventually(Effect.sync(() => output.sent.current), (all) => all.length === 2)).length).toBe(2)
    expect(flush.pollUnsafe()).toBeUndefined()
    output.acknowledge()
    output.emit("drain")
    yield* Fiber.join(second)
    yield* Fiber.join(flush)
  })))
})

test("native close before acknowledgement fails the accepted send and flush", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const input = new Readable({ read() {} })
    const output = new ManualWriter()
    yield* Effect.addFinalizer(() => Effect.sync(() => { input.destroy(); output.destroy() }))
    const peer = Context.get(yield* Layer.build(StdioPeerLive({ input, output })), ProcessPeer)
    const sent = yield* Effect.result(peer.send(hello())).pipe(Effect.forkScoped)
    yield* eventually(Effect.sync(() => output.sent.current), (all) => all.length > 0)
    output.emit("close")
    const result = yield* Fiber.join(sent)
    const flush = yield* Effect.result(peer.flush)
    expect(Result.isFailure(result) && result.failure.reason).toBe("Closed")
    expect(Result.isFailure(flush) && flush.failure.reason).toBe("Closed")
  })))
})

test("peer snapshots full events without prototype hooks and rejects a non-JSON result", async () => {
  const session = { id: ConversationId.make("10000000-0000-4000-8000-000000000001"), owner: "host" }
  const data = { value: 42 }
  const hooks = MutableRef.make(0)
  Object.setPrototypeOf(data, { toJSON() { hooks.current += 1; return { replaced: true } } })
  const event: ProcessEvent = {
    _tag: "turn.event", session, turn: 1, runId: RunId.make("run"),
    progress: { mode: "full", event: { _tag: "host", name: "app.progress", data } },
  }
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const fixture = yield* stdioPeerSubject.open()
    yield* fixture.peer.send(event)
    expect(hooks.current).toBe(0)
    expect(new TextDecoder().decode((yield* fixture.writes)[0])).toContain('"data":{"value":42}')
  })))
  Object.defineProperty(data, "value", { get: () => 1n })
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const fixture = yield* stdioPeerSubject.open()
    const result = yield* Effect.result(fixture.peer.send(event))
    expect(Result.isFailure(result) && result.failure.reason).toBe("InvalidEvent")
    if (Result.isFailure(result)) expect(result.failure.message).toBe("The process event could not be encoded")
    expect((yield* fixture.writes).length).toBe(0)
  })))
})

test("oversized output fails before a native write and remains failed", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const fixture = yield* stdioPeerSubject.open({ maxFrameBytes: 8 })
    const send = yield* Effect.result(fixture.peer.send(hello()))
    const flush = yield* Effect.result(fixture.peer.flush)
    expect(Result.isFailure(send) && send.failure.reason).toBe("FrameTooLarge")
    expect(Result.isFailure(flush) && flush.failure.reason).toBe("FrameTooLarge")
    expect((yield* fixture.writes).length).toBe(0)
  })))
})

test("output limits count UTF-8 bytes and exclude the terminating LF", async () => {
  const event: ProcessEvent = { _tag: "error", code: "host.runtime", message: "😀 café", fatal: false }
  const length = bytes(JSON.stringify(event)).byteLength
  await Effect.runPromise(Effect.forEach([length - 1, length], (maxFrameBytes) => Effect.scoped(Effect.gen(function*() {
    const fixture = yield* stdioPeerSubject.open({ maxFrameBytes })
    const result = yield* Effect.result(fixture.peer.send(event))
    expect(Result.isSuccess(result)).toBe(maxFrameBytes === length)
    const writes = yield* fixture.writes
    expect(writes.length).toBe(maxFrameBytes === length ? 1 : 0)
    if (writes.length > 0) expect(writes[0]?.byteLength).toBe(length + 1)
  })), { concurrency: 1 }))
})

test("native callback errors remain typed and do not leak native text", async () => {
  const input = new Readable({ read() {} })
  const output = new Writable({ write(_data, _encoding, callback) { callback(new Error("private native marker")) } })
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const peer = yield* ProcessPeer
    return yield* Effect.result(peer.send(hello()))
  }).pipe(Effect.provide(StdioPeerLive({ input, output })))))
  expect(Result.isFailure(result) && result.failure.reason).toBe("Output")
  if (Result.isFailure(result)) expect(result.failure.message).toBe("The process output failed")
  input.destroy()
  output.destroy()
})

test("write timeout fails send and flush with the same retained failure", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const fixture = yield* stdioPeerSubject.open({ holdWrites: true, writeTimeoutMs: 10 })
    const result = yield* Effect.result(fixture.peer.send(hello()))
    const flush = yield* Effect.result(fixture.peer.flush)
    expect(Result.isFailure(result) && result.failure.reason).toBe("WriteTimeout")
    expect(Result.isFailure(flush) && flush.failure.reason).toBe("WriteTimeout")
  })))
})

test("native input failure wakes a blocked reader", async () => {
  const input = new Readable({ read() {} })
  const output = new Writable({ write(_data, _encoding, callback) { callback() } })
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const peer = yield* ProcessPeer
    const read = yield* Effect.result(Stream.runDrain(peer.commands)).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    input.destroy(new Error("native input failure"))
    const result = yield* Fiber.join(read)
    expect(Result.isFailure(result) && result.failure.reason).toBe("Input")
  }).pipe(Effect.provide(StdioPeerLive({ input, output })))))
  output.destroy()
})

test("scope disposal cleans only owned listeners and preserves injected streams", async () => {
  const input = new Readable({ read() {} })
  const output = new Writable({ write(_data, _encoding, callback) { callback() } })
  const onError = () => {}
  input.on("error", onError)
  output.on("error", onError)
  const names = ["readable", "end", "error", "close", "finish", "drain"]
  const before = names.map((name) => [input.listenerCount(name), output.listenerCount(name)])
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const peer = yield* ProcessPeer
    yield* peer.send(hello())
    yield* peer.flush
  }).pipe(Effect.provide(StdioPeerLive({ input, output })))))
  expect(names.map((name) => [input.listenerCount(name), output.listenerCount(name)])).toEqual(before)
  expect(input.destroyed).toBe(false)
  expect(output.destroyed).toBe(false)
  input.destroy()
  output.destroy()
})

test("scope disposal cancels a held native wait without closing the injected streams", async () => {
  const input = new Readable({ read() {} })
  const output = new ManualWriter()
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const peer = Context.get(yield* Layer.build(StdioPeerLive({ input, output })), ProcessPeer)
    yield* Effect.result(peer.send(hello())).pipe(Effect.forkScoped)
    expect((yield* eventually(Effect.sync(() => output.sent.current), (all) => all.length > 0)).length).toBe(1)
  })))
  expect(input.destroyed).toBe(false)
  expect(output.destroyed).toBe(false)
  expect(output.listenerCount("drain")).toBe(0)
  expect(output.listenerCount("error")).toBe(0)
  input.destroy()
  output.destroy()
})

test("an already closed input fails instead of waiting for an event that already happened", async () => {
  const input = new Readable({ read() {} })
  input.destroy()
  const output = new Writable({ write(_data, _encoding, callback) { callback() } })
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const peer = yield* ProcessPeer
    return yield* Effect.result(Stream.runDrain(peer.commands))
  }).pipe(Effect.provide(StdioPeerLive({ input, output })))))
  expect(Result.isFailure(result) && result.failure.reason).toBe("Closed")
  output.destroy()
})

test("invalid options and encoded input fail at the layer boundary", async () => {
  await Effect.runPromise(Effect.forEach([
    { maxFrameBytes: 0 }, { maxPendingWrites: Number.POSITIVE_INFINITY }, { readChunkBytes: 1024 * 1024 * 1024 + 1 }, { writeTimeoutMs: 2147483648 },
  ], (options) => Effect.scoped(Effect.gen(function*() {
    const result = yield* Effect.result(Layer.build(StdioPeerLive(options)))
    expect(Result.isFailure(result) && result.failure._tag).toBe("HarnessError")
    if (Result.isFailure(result)) expect(result.failure.message).toBe("Invalid process peer options")
  })), { concurrency: 1 }))
  const input = new Readable({ read() {} }).setEncoding("utf8")
  const result = await Effect.runPromise(Effect.scoped(Effect.result(Layer.build(StdioPeerLive({ input })))))
  expect(Result.isFailure(result) && result.failure.message).toBe("Process peer streams must use binary mode")
  input.destroy()
})
