import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, MutableRef, Option } from "effect"
import { ProcessRequestId } from "./process-protocol.entity.js"
import { stdioPeerSubject } from "./stdio-peer.testing.js"

test("a masked post-ACK caller still receives the native write timeout", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* stdioPeerSubject.open({ holdWrites: true, writeTimeoutMs: 20 })
    const entered = MutableRef.make(false)
    const send = yield* Effect.uninterruptible(fixture.peer.send({ _tag: "hello", requestId: ProcessRequestId.make("masked"), protocolVersion: 1 })).pipe(Effect.forkScoped)
    yield* Effect.repeat(fixture.writes.pipe(Effect.tap((writes) => Effect.sync(() => { entered.current = writes.length === 1 }))), { while: () => !entered.current })
    yield* Effect.sleep(100)
    const timedOutBeforeCallback = send.pollUnsafe()
    // Always release the native callback so a failure of this check cannot hang scope cleanup.
    yield* fixture.releaseWrites
    const exit = yield* Fiber.await(send)
    expect(timedOutBeforeCallback).toBeDefined()
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Option.getOrThrow(Cause.findErrorOption(exit.cause)).reason).toBe("WriteTimeout")
  })))
})
