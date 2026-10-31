import { expect, test } from "bun:test"
import { Effect, Result, Stream } from "effect"
import { processPeerConformance } from "./process-peer.conformance.js"
import type { ProcessPeerSubject } from "./process-peer.conformance.js"

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
    "rejects excess pending writers before encoding",
    "preserves the first output failure for flush and later sends",
  ])
})

processPeerConformance(careless).forEach((entry) => {
  test(`careless peer fails: ${entry.name}`, async () => {
    const result = await Effect.runPromise(Effect.result(entry.run))
    expect(Result.isFailure(result)).toBe(true)
  })
})
