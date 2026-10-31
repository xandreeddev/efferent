import { stdin, stdout } from "node:process"
import type { Readable, Writable } from "node:stream"
import { Cause, Deferred, Effect, Exit, Layer, MutableRef, Option, Queue, Schema, Semaphore, Stream } from "effect"
import { harnessError } from "@xandreed/core"
import { ProcessPeer } from "./ports/process-peer.port.js"
import {
  PROCESS_PEER_DEFAULTS,
  ProcessPeerError,
  ProcessPeerPhase,
  ProcessInputPhase,
  ProcessPeerOptions,
} from "./process-peer.entity.js"
import type { ProcessPeerDirection, ProcessPeerReason } from "./process-peer.entity.js"
import { decodeProcessCommand, encodeProcessEvent } from "./process-protocol.entity.functions.js"
import type { ProcessCommand, ProcessEvent } from "./process-protocol.entity.js"

/** Host-owned native streams remain open when the peer scope closes. @public */
export interface StdioPeerOptions extends Partial<ProcessPeerOptions> {
  readonly input?: Readable
  readonly output?: Writable
}

const messages: Readonly<Record<ProcessPeerReason, string>> = {
  Input: "The process input failed",
  InvalidFrame: "The process command is invalid",
  InvalidUtf8: "The process frame is not valid UTF-8",
  FrameTooLarge: "The process frame exceeds the configured byte limit",
  InvalidEvent: "The process event could not be encoded",
  Output: "The process output failed",
  WriteTimeout: "The process write acknowledgement timed out",
  Capacity: "The process writer capacity is exhausted",
  Closed: "The process peer is closed",
}
/** One native-error mapping boundary; foreign messages never become protocol messages. */
const peerError = (reason: ProcessPeerReason, direction: ProcessPeerDirection, cause?: unknown) =>
  new ProcessPeerError({ reason, direction, message: messages[reason], ...(cause === undefined ? {} : { cause }) })

const makePeer = Effect.fnUntraced(function*(options: StdioPeerOptions) {
  const config = yield* Schema.decodeUnknownEffect(ProcessPeerOptions)({
    ...PROCESS_PEER_DEFAULTS,
    ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== "input" && key !== "output")),
  }, { onExcessProperty: "error" }).pipe(Effect.mapError(() => harnessError("config.options", "Invalid process peer options")))
  const input = options.input ?? stdin
  const output = options.output ?? stdout
  if (input.readableObjectMode || input.readableEncoding !== null || output.writableObjectMode) {
    return yield* Effect.fail(harnessError("config.options", "Process peer streams must use binary mode"))
  }
  const scope = yield* Effect.scope
  const wake = yield* Queue.sliding<void>(1)
  const serial = yield* Semaphore.make(1)
  const phase = MutableRef.make<ProcessPeerPhase>({ _tag: "Open" })
  const source = MutableRef.make<ProcessInputPhase>(input.readableEnded ? { _tag: "Ended" }
    : input.destroyed ? { _tag: "Failed", error: peerError("Closed", "input") } : { _tag: "Open" })
  const consumed = MutableRef.make(false)
  const disposed = MutableRef.make(false)
  const pending = new Set<Deferred.Deferred<void, ProcessPeerError>>()
  const activeWrite = MutableRef.make(Option.none<Deferred.Deferred<void, ProcessPeerError>>())
  const partial = MutableRef.make(new Uint8Array(Math.min(config.readChunkBytes, config.maxFrameBytes + 1)))
  const partialSize = MutableRef.make(0)
  const chunk = MutableRef.make<Uint8Array>(new Uint8Array(0))
  const offset = MutableRef.make(0)
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const encoder = new TextEncoder()

  const currentFailure = (): Option.Option<ProcessPeerError> => ProcessPeerPhase.match(phase.current, {
    Open: () => Option.none(),
    Failed: ({ error }) => Option.some(error),
    Closed: () => Option.some(peerError("Closed", "output")),
  })
  const signal = () => { Queue.offerUnsafe(wake, undefined) }
  const latch = (error: ProcessPeerError) => {
    const first = Option.getOrElse(currentFailure(), () => error)
    phase.current = { _tag: "Failed", error: first }
    source.current = { _tag: "Failed", error: first }
    pending.forEach((ack) => { Deferred.doneUnsafe(ack, Effect.fail(first)) })
    Option.map(activeWrite.current, (ack) => Deferred.doneUnsafe(ack, Effect.fail(first)))
    signal()
  }
  const onReadable = () => { signal() }
  const onInputEnd = () => { if (source.current._tag === "Open") source.current = { _tag: "Ended" }; signal() }
  const onInputError = (cause: unknown) => { source.current = { _tag: "Failed", error: peerError("Input", "input", cause) }; signal() }
  const onInputClose = () => {
    if (!input.readableEnded && source.current._tag === "Open" && !disposed.current) {
      source.current = { _tag: "Failed", error: peerError("Closed", "input") }
    }
    signal()
  }
  const onOutputError = (cause: unknown) => { latch(peerError("Output", "output", cause)) }
  const onOutputClose = () => { if (!disposed.current) latch(peerError("Closed", "output")) }
  input.on("readable", onReadable)
  input.on("end", onInputEnd)
  input.on("error", onInputError)
  input.on("close", onInputClose)
  output.on("error", onOutputError)
  output.on("close", onOutputClose)
  output.on("finish", onOutputClose)
  yield* Effect.addFinalizer(() => Effect.gen(function*() {
    disposed.current = true
    const error = Option.getOrElse(currentFailure(), () => peerError("Closed", "output"))
    if (phase.current._tag === "Open") phase.current = { _tag: "Closed" }
    source.current = { _tag: "Failed", error }
    pending.forEach((ack) => { Deferred.doneUnsafe(ack, Effect.fail(error)) })
    Option.map(activeWrite.current, (ack) => Deferred.doneUnsafe(ack, Effect.fail(error)))
    signal()
    // A synchronous native callback can schedule its error event on the next tick.
    yield* Effect.callback<void>((resume) => {
      const handle = setImmediate(() => resume(Effect.void))
      return Effect.sync(() => clearImmediate(handle))
    })
    input.off("readable", onReadable)
    input.off("end", onInputEnd)
    input.off("error", onInputError)
    input.off("close", onInputClose)
    output.off("error", onOutputError)
    output.off("close", onOutputClose)
    output.off("finish", onOutputClose)
    yield* Queue.shutdown(wake)
  }))

  const append = (bytes: Uint8Array) => Effect.try({
    try: () => {
      const required = partialSize.current + bytes.byteLength
      const last = bytes.byteLength > 0 ? bytes[bytes.byteLength - 1] : partial.current[partialSize.current - 1]
      if (required > config.maxFrameBytes + 1 || (required > config.maxFrameBytes && last !== 13)) {
        return false
      }
      if (required > partial.current.byteLength) {
        const grown = new Uint8Array(Math.min(config.maxFrameBytes + 1, Math.max(required, partial.current.byteLength * 2)))
        grown.set(partial.current.subarray(0, partialSize.current))
        partial.current = grown
      }
      partial.current.set(bytes, partialSize.current)
      partialSize.current = required
      return true
    },
    catch: (cause) => peerError("Input", "input", cause),
  }).pipe(Effect.flatMap((fits) => fits ? Effect.void : Effect.fail(peerError("FrameTooLarge", "input"))))

  const nativeChunk = Effect.fnUntraced(function*(): Effect.fn.Return<boolean, ProcessPeerError> {
    const result = MutableRef.make(Option.none<boolean>())
    yield* Effect.whileLoop({
      while: () => Option.isNone(result.current),
      body: () => Effect.gen(function*() {
        const failure = source.current
        if (failure._tag === "Failed") return yield* Effect.fail(failure.error)
        const raw: unknown = yield* Effect.try({
          try: () => input.read(Math.min(config.readChunkBytes, Math.max(1, input.readableLength))),
          catch: (cause) => peerError("Input", "input", cause),
        })
        if (raw !== null) {
          const data = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(raw).pipe(Effect.mapError((cause) => peerError("Input", "input", cause)))
          if (data.byteLength > config.readChunkBytes || data.byteLength === 0) return yield* Effect.fail(peerError("Input", "input"))
          chunk.current = data
          offset.current = 0
          result.current = Option.some(true)
          return
        }
        yield* ProcessInputPhase.match(source.current, {
          Failed: ({ error }) => Effect.fail(error),
          Ended: () => Effect.sync(() => { result.current = Option.some(false) }),
          Open: () => Queue.take(wake),
        })
      }),
      step: () => {},
    })
    return Option.getOrElse(result.current, () => false)
  })

  const nextCommand = Effect.fnUntraced(function*(): Effect.fn.Return<readonly [ProcessCommand, void] | undefined, ProcessPeerError> {
    const result = MutableRef.make(Option.none<Option.Option<ProcessCommand>>())
    yield* Effect.whileLoop({
      while: () => Option.isNone(result.current),
      body: () => Effect.gen(function*() {
        if (source.current._tag === "Failed") return yield* Effect.fail(source.current.error)
        if (offset.current >= chunk.current.byteLength) {
          const more = yield* nativeChunk()
          if (!more) {
            if (partialSize.current !== 0) return yield* Effect.fail(peerError("InvalidFrame", "input"))
            result.current = Option.some(Option.none())
            return
          }
        }
        const end = chunk.current.indexOf(10, offset.current)
        const boundary = end < 0 ? chunk.current.byteLength : end
        yield* append(chunk.current.subarray(offset.current, boundary))
        offset.current = boundary + (end < 0 ? 0 : 1)
        if (end < 0) return
        const size = partialSize.current - (partial.current[partialSize.current - 1] === 13 ? 1 : 0)
        if (size > config.maxFrameBytes) return yield* Effect.fail(peerError("FrameTooLarge", "input"))
        const text = yield* Effect.try({ try: () => decoder.decode(partial.current.subarray(0, size)), catch: (cause) => peerError("InvalidUtf8", "input", cause) })
        partialSize.current = 0
        if (text.length === 0 || text.charCodeAt(0) === 0xfeff) return yield* Effect.fail(peerError("InvalidFrame", "input"))
        result.current = Option.some(Option.some(yield* decodeProcessCommand(text)))
      }),
      step: () => {},
    })
    return Option.match(Option.flatten(result.current), { onNone: () => undefined, onSome: (command) => [command, undefined] as const })
  })
  const commands = Stream.unwrap(Effect.suspend(() => {
    if (consumed.current) return Effect.fail(peerError("Closed", "input"))
    consumed.current = true
    return Effect.succeed(Stream.unfold(undefined, () => nextCommand()))
  }))

  const nativeWrite = Effect.fnUntraced(function*(line: Uint8Array) {
    const ack = yield* Deferred.make<void, ProcessPeerError>()
    const flags = MutableRef.make({ callback: false, drain: false, returned: false, needDrain: false })
    const complete = () => {
      const state = flags.current
      if (state.returned && state.callback && (!state.needDrain || state.drain)) Deferred.doneUnsafe(ack, Effect.void)
    }
    const onDrain = () => { flags.current = { ...flags.current, drain: true }; complete() }
    yield* Effect.acquireUseRelease(
      Effect.sync(() => { activeWrite.current = Option.some(ack); output.on("drain", onDrain) }),
      () => Effect.gen(function*() {
        const accepted = yield* Effect.try({
          try: () => output.write(line, (cause) => {
            if (cause !== undefined && cause !== null) { latch(peerError("Output", "output", cause)); return }
            flags.current = { ...flags.current, callback: true }
            complete()
          }),
          catch: (cause) => peerError("Output", "output", cause),
        })
        flags.current = { ...flags.current, returned: true, needDrain: !accepted }
        complete()
        yield* Deferred.await(ack).pipe(Effect.timeoutOrElse({ duration: config.writeTimeoutMs, orElse: () => Effect.fail(peerError("WriteTimeout", "output")) }))
      }),
      () => Effect.sync(() => { output.off("drain", onDrain); activeWrite.current = Option.none() }),
    )
  })

  const writeEvent = Effect.fnUntraced(function*(event: ProcessEvent) {
    const failure = currentFailure()
    if (Option.isSome(failure)) return yield* Effect.fail(failure.value)
    if (output.destroyed || output.writableEnded) return yield* Effect.fail(peerError("Closed", "output"))
    const text = yield* encodeProcessEvent(event)
    const byteLength = Buffer.byteLength(text, "utf8")
    if (byteLength > config.maxFrameBytes) return yield* Effect.fail(peerError("FrameTooLarge", "output"))
    yield* nativeWrite(encoder.encode(`${text}\n`))
  })
  const send = Effect.fn("process_peer.send")((event: ProcessEvent) => Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
    const ack = yield* Deferred.make<void, ProcessPeerError>()
    yield* Effect.suspend(() => {
      const failure = currentFailure()
      if (Option.isSome(failure)) return Effect.fail(failure.value)
      if (pending.size >= config.maxPendingWrites) return Effect.fail(peerError("Capacity", "output"))
      pending.add(ack)
      return Effect.void
    })
    const worker = serial.withPermit(writeEvent(event)).pipe(
      Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.fail(peerError("Closed", "output"))
        : Effect.fail(Option.getOrElse(Cause.findErrorOption(cause), () => peerError("Output", "output", cause)))),
      Effect.onExit((exit) => Effect.sync(() => {
        Exit.match(exit, {
          onFailure: (cause) => {
            const error = Option.getOrElse(Cause.findErrorOption(cause), () => peerError("Output", "output", cause))
            latch(error)
            Deferred.doneUnsafe(ack, Effect.fail(error))
          },
          onSuccess: () => { Deferred.doneUnsafe(ack, Effect.void) },
        })
        pending.delete(ack)
      })),
      Effect.exit,
    )
    yield* Effect.forkIn(restore(worker), scope)
    yield* restore(Deferred.await(ack))
  })))
  const flush = Effect.gen(function*() {
    const snapshot = yield* Effect.sync(() => ({ failure: currentFailure(), accepted: Array.from(pending) }))
    if (Option.isSome(snapshot.failure)) return yield* Effect.fail(snapshot.failure.value)
    yield* Effect.forEach(snapshot.accepted, (ack) => Deferred.await(ack), { concurrency: 1, discard: true })
    const failure = currentFailure()
    if (Option.isSome(failure)) return yield* Effect.fail(failure.value)
  }).pipe(Effect.withSpan("process_peer.flush"))
  return ProcessPeer.of({ commands, send, flush })
})

/** Bounded binary NDJSON over Node-compatible streams on Node 24 and Bun. @public */
export const StdioPeerLive = (options: StdioPeerOptions = {}) => Layer.effect(ProcessPeer, makePeer(options))
