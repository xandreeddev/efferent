import { Readable, Writable } from "node:stream"
import { Context, Effect, Layer, MutableRef } from "effect"
import { ProcessPeer } from "./ports/process-peer.port.js"
import type { ProcessPeerSubject } from "./process-peer.conformance.js"
import { StdioPeerLive } from "./stdio-peer.adapter.js"

export const stdioPeerSubject: ProcessPeerSubject = {
  open: (options = {}) => Effect.gen(function*() {
    const writes = MutableRef.make<ReadonlyArray<Uint8Array>>([])
    const held = MutableRef.make(options.holdWrites ?? false)
    const callbacks = MutableRef.make<ReadonlyArray<() => void>>([])
    const input = new Readable({ read() {} })
    const output = new Writable({
      highWaterMark: 1,
      write(data: Uint8Array, _encoding, callback) {
        writes.current = [...writes.current, new Uint8Array(data)]
        if (held.current) callbacks.current = [...callbacks.current, () => callback()]
        else callback()
      },
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => { input.destroy(); output.destroy() }))
    const { holdWrites: _, ...bounds } = options
    const peer = Context.get(yield* Layer.build(StdioPeerLive({ ...bounds, input, output })), ProcessPeer)
    return {
      peer,
      feed: (bytes: Uint8Array) => Effect.sync(() => { input.push(bytes) }),
      finishInput: Effect.sync(() => { input.push(null) }),
      writes: Effect.sync(() => writes.current),
      releaseWrites: Effect.sync(() => {
        held.current = false
        const waiting = callbacks.current
        callbacks.current = []
        waiting.forEach((callback) => callback())
      }),
      failOutput: Effect.sync(() => { output.destroy(new Error("native output failure")) }),
    }
  }),
}
