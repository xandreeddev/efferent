import { Effect, Fiber, Result, Stream } from "effect"
import type { Context, Scope } from "effect"
import { check, ConformanceFailure } from "@xandreed/core/conformance"
import type { ConformanceCheck } from "@xandreed/core/conformance"
import type { ProcessPeer } from "./ports/process-peer.port.js"
import type { ProcessPeerOptions } from "./process-peer.entity.js"
import { ProcessRequestId } from "./process-protocol.entity.js"
import type { ProcessEvent } from "./process-protocol.entity.js"

/** Native-driver controls used to run the peer contract against an adapter. @public */
export interface ProcessPeerFixture {
  readonly peer: Context.Service.Shape<typeof ProcessPeer>
  readonly feed: (bytes: Uint8Array) => Effect.Effect<void>
  readonly finishInput: Effect.Effect<void>
  readonly writes: Effect.Effect<ReadonlyArray<Uint8Array>>
  readonly releaseWrites: Effect.Effect<void>
  readonly failOutput: Effect.Effect<void>
}

/** Opens a fresh scoped peer; held writes withhold their native acknowledgement. @public */
export interface ProcessPeerSubject {
  readonly open: (options?: Partial<ProcessPeerOptions> & { readonly holdWrites?: boolean }) => Effect.Effect<ProcessPeerFixture, unknown, Scope.Scope>
}

const bytes = (text: string) => new TextEncoder().encode(text)
const hello = (id = "one"): ProcessEvent => ({ _tag: "hello", requestId: ProcessRequestId.make(id), protocolVersion: 1 })
const expect = (id: string, holds: boolean, message: string) => holds ? Effect.void : Effect.fail(new ConformanceFailure({ check: id, message }))
const eventually = <A>(read: Effect.Effect<A>, holds: (value: A) => boolean, tries = 200): Effect.Effect<A> =>
  read.pipe(Effect.flatMap((value) => holds(value) || tries <= 0 ? Effect.succeed(value)
    : Effect.yieldNow.pipe(Effect.andThen(Effect.suspend(() => eventually(read, holds, tries - 1))))))
const outputText = (chunks: ReadonlyArray<Uint8Array>) => chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")

/**
 * Checks: split-crlf, invalid-frame, invalid-utf8, unterminated, frame-bound,
 * single-consumer, ordered-output, flush-barrier, writer-capacity, failure-latch.
 * Each check opens a fresh peer; test drivers control input and native write ACKs.
 * @public
 */
export const processPeerConformance = (subject: ProcessPeerSubject): ReadonlyArray<ConformanceCheck> => [
  check("reads split UTF-8 commands and CRLF without losing subsequent frames", "split-crlf", () => Effect.scoped(Effect.gen(function*() {
    const fixture = yield* subject.open({ readChunkBytes: 3 })
    const collected = yield* Stream.runCollect(fixture.peer.commands).pipe(Effect.forkScoped)
    yield* fixture.feed(bytes('{"_tag":"hello","requestId":"first","protocolVersion":1}\r'))
    yield* fixture.feed(bytes('\n{"_tag":"ping","requestId":"second"}\n'))
    yield* fixture.finishInput
    const commands = yield* Fiber.join(collected)
    yield* expect("split-crlf", commands.length === 2 && commands[0]?._tag === "hello" && commands[1]?.requestId === "second", "split commands must arrive in order")
  }))),
  check("rejects a blank command frame", "invalid-frame", () => Effect.scoped(Effect.gen(function*() {
    const fixture = yield* subject.open()
    yield* fixture.feed(bytes("\n"))
    yield* fixture.finishInput
    const result = yield* Effect.result(Stream.runDrain(fixture.peer.commands))
    yield* expect("invalid-frame", Result.isFailure(result) && result.failure.reason === "InvalidFrame", "blank input must fail with InvalidFrame")
  }))),
  check("rejects malformed UTF-8", "invalid-utf8", () => Effect.scoped(Effect.gen(function*() {
    const fixture = yield* subject.open()
    yield* fixture.feed(new Uint8Array([0xc3, 0x28, 0x0a]))
    yield* fixture.finishInput
    const result = yield* Effect.result(Stream.runDrain(fixture.peer.commands))
    yield* expect("invalid-utf8", Result.isFailure(result) && result.failure.reason === "InvalidUtf8", "invalid bytes must fail with InvalidUtf8")
  }))),
  check("rejects an unterminated final frame", "unterminated", () => Effect.scoped(Effect.gen(function*() {
    const fixture = yield* subject.open()
    yield* fixture.feed(bytes('{"_tag":"ping","requestId":"one"}'))
    yield* fixture.finishInput
    const result = yield* Effect.result(Stream.runDrain(fixture.peer.commands))
    yield* expect("unterminated", Result.isFailure(result) && result.failure.reason === "InvalidFrame", "EOF must not silently commit a partial frame")
  }))),
  check("bounds partial input frames", "frame-bound", () => Effect.scoped(Effect.gen(function*() {
    const fixture = yield* subject.open({ maxFrameBytes: 8, readChunkBytes: 3 })
    yield* fixture.feed(bytes("123456789\n"))
    yield* fixture.finishInput
    const result = yield* Effect.result(Stream.runDrain(fixture.peer.commands))
    yield* expect("frame-bound", Result.isFailure(result) && result.failure.reason === "FrameTooLarge", "oversized input must fail before decoding")
  }))),
  check("permits only one lifetime command consumer", "single-consumer", () => Effect.scoped(Effect.gen(function*() {
    const fixture = yield* subject.open()
    yield* fixture.finishInput
    yield* Stream.runDrain(fixture.peer.commands)
    const result = yield* Effect.result(Stream.runDrain(fixture.peer.commands))
    yield* expect("single-consumer", Result.isFailure(result) && result.failure.reason === "Closed", "a second consumer must be rejected")
  }))),
  check("writes complete ordered LF-delimited frames", "ordered-output", () => Effect.scoped(Effect.gen(function*() {
    const fixture = yield* subject.open()
    yield* fixture.peer.send(hello("one"))
    yield* fixture.peer.send(hello("two"))
    yield* fixture.peer.flush
    const text = outputText(yield* fixture.writes)
    yield* expect("ordered-output", text === '{"_tag":"hello","requestId":"one","protocolVersion":1}\n{"_tag":"hello","requestId":"two","protocolVersion":1}\n', "output must contain exactly two ordered complete frames")
  }))),
  check("flush awaits every accepted write acknowledgement", "flush-barrier", () => Effect.scoped(Effect.gen(function*() {
    const fixture = yield* subject.open({ holdWrites: true })
    const send = yield* fixture.peer.send(hello()).pipe(Effect.forkScoped)
    const writes = yield* eventually(fixture.writes, (chunks) => chunks.length > 0)
    yield* expect("flush-barrier", writes.length === 1, "the accepted write must reach the native writer")
    const flush = yield* fixture.peer.flush.pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* expect("flush-barrier", flush.pollUnsafe() === undefined && send.pollUnsafe() === undefined, "neither send nor flush may complete before the native ACK")
    yield* fixture.releaseWrites
    yield* Fiber.join(send)
    yield* Fiber.join(flush)
  }))),
  check("rejects excess pending writers before encoding", "writer-capacity", () => Effect.scoped(Effect.gen(function*() {
    const fixture = yield* subject.open({ holdWrites: true, maxPendingWrites: 1 })
    const send = yield* fixture.peer.send(hello()).pipe(Effect.forkScoped)
    const writes = yield* eventually(fixture.writes, (chunks) => chunks.length > 0)
    yield* expect("writer-capacity", writes.length === 1, "the first write must occupy the bounded slot")
    const result = yield* Effect.result(fixture.peer.send(hello("two")))
    yield* expect("writer-capacity", Result.isFailure(result) && result.failure.reason === "Capacity", "excess pending writes must fail with Capacity")
    yield* fixture.releaseWrites
    yield* Fiber.join(send)
  }))),
  check("preserves the first output failure for flush and later sends", "failure-latch", () => Effect.scoped(Effect.gen(function*() {
    const fixture = yield* subject.open({ holdWrites: true })
    const send = yield* Effect.result(fixture.peer.send(hello())).pipe(Effect.forkScoped)
    const writes = yield* eventually(fixture.writes, (chunks) => chunks.length > 0)
    yield* expect("failure-latch", writes.length === 1, "the write must be accepted before failing output")
    yield* fixture.failOutput
    const first = yield* Fiber.join(send)
    const flushed = yield* Effect.result(fixture.peer.flush)
    const later = yield* Effect.result(fixture.peer.send(hello("later")))
    yield* expect("failure-latch", Result.isFailure(first) && Result.isFailure(flushed) && Result.isFailure(later)
      && first.failure.reason === flushed.failure.reason && first.failure.reason === later.failure.reason,
    "output failure must remain observable after pending writers settle")
  }))),
]
