import { expect, test } from "bun:test"
import { Effect, Ref, Result, Stream } from "effect"
import { ProcessPeerError } from "./process-peer.entity.js"
import { processPeerConformance } from "./process-peer.conformance.js"
import type { ProcessPeerSubject } from "./process-peer.conformance.js"
import { stdioPeerSubject } from "./stdio-peer.testing.js"

const careless: ProcessPeerSubject = { open: () => Effect.succeed({
  peer: { commands: Stream.empty, send: () => Effect.void, flush: Effect.void },
  feed: () => Effect.void,
  finishInput: Effect.void,
  writes: Effect.succeed([]),
  releaseWrites: Effect.void,
  failOutput: Effect.void,
}) }

test("peer kit documents its exact check names", () => {
  expect(processPeerConformance(careless).map((entry) => entry.name)).toEqual([
    "reads split UTF-8 commands and CRLF without losing subsequent frames",
    "rejects a blank command frame",
    "rejects malformed UTF-8",
    "rejects an unterminated final frame",
    "bounds partial input frames",
    "permits only one lifetime command consumer",
    "writes complete ordered LF-delimited frames",
    "flush awaits every accepted write acknowledgement",
    "makes an excess writer wait for a bounded slot, before encoding, for at most the write timeout",
    "preserves the first output failure for flush and later sends",
  ])
})

processPeerConformance(careless).forEach((entry) => {
  test(`careless peer fails: ${entry.name}`, async () => {
    const result = await Effect.runPromise(Effect.result(entry.run))
    expect(Result.isFailure(result)).toBe(true)
  })
})

/** The real peer, made to refuse an excess writer at once instead of letting it wait for a slot. */
const impatient: ProcessPeerSubject = { open: (options = {}) => Effect.gen(function* () {
  const fixture = yield* stdioPeerSubject.open(options)
  const inFlight = yield* Ref.make(0)
  const limit = options.maxPendingWrites ?? 64
  return { ...fixture, peer: { ...fixture.peer, send: (event) => Ref.modify(inFlight, (count) => [count < limit, count < limit ? count + 1 : count] as const).pipe(
    Effect.flatMap((admitted) => admitted
      ? fixture.peer.send(event).pipe(Effect.ensuring(Ref.update(inFlight, (count) => count - 1)))
      : Effect.fail(new ProcessPeerError({ reason: "Capacity", direction: "output", message: "The process writer capacity is exhausted" }))),
  ) } }
}) }

test("a peer that refuses excess writers at once fails only the writer-capacity check", async () => {
  const failed = await Promise.all(processPeerConformance(impatient).map((entry) => Effect.runPromise(Effect.result(entry.run)).then((result) => Result.isFailure(result) ? [result.failure.check] : [])))
  expect(failed.flat()).toEqual(["writer-capacity"])
})
