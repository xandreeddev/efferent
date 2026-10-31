import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { EntryId } from "../memory/memory-log.entity.js"
import { CurrentToolResultReceipt } from "../ports/tool-result-receipt.port.js"
import type { ToolResultReceiptTarget } from "./tool-result-receipt.entity.js"
import { ToolCallId } from "./message.entity.js"
import { InvocationId, RunId, RunOrdinal } from "./run.entity.js"
import { makeToolResultReceipt, withToolResultReceiptGuard } from "./tool-result-receipt.entity.functions.js"

const target = (): ToolResultReceiptTarget => ({ tool: "read", toolCallId: ToolCallId.make("same-id"), step: 0,
  run: Option.some({ id: RunId.make("receipt-run"), turn: 1, ordinal: RunOrdinal.make(0) }) })
const invocationId = InvocationId.make("receipt-run:call:1")

test("only an exact first handle enters; guard exposes no transferable state", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const receipt = yield* makeToolResultReceipt(target())
    expect(Option.isNone(yield* receipt.offer.enter({ ...target(), step: 1 }))).toBe(true)
    const owners = yield* Effect.all([receipt.offer.enter(target()), receipt.offer.enter(target())], { concurrency: 2 })
    expect(owners.filter(Option.isSome)).toHaveLength(1)
    expect(yield* receipt.guard.status).toBe("Entered")
    expect(Object.keys(receipt.guard)).toEqual(["target", "status"])
    yield* receipt.close
    expect(yield* receipt.guard.status).toBe("Closed")
    expect(Option.isNone(yield* receipt.offer.enter(target()))).toBe(true)
  }))
})

test("claim, ready, raw reservation and actual ACK advance once in order", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const receipt = yield* makeToolResultReceipt(target())
    const owner = Option.getOrThrow(yield* receipt.offer.enter(target()))
    yield* owner.claim(invocationId)
    expect(yield* receipt.guard.status).toBe("Claimed")
    yield* owner.ready(Option.some({ invocationId, effectiveInput: null }))
    expect(yield* receipt.guard.status).toBe("Ready")
    const reservation = yield* receipt.recording.reserve(target())
    expect(yield* receipt.guard.status).toBe("Recording")
    expect(reservation.metadata).toEqual(Option.some({ invocationId, effectiveInput: null }))
    expect((yield* receipt.recording.reserve(target()).pipe(Effect.result))._tag).toBe("Failure")
    yield* reservation.recorded(EntryId.make("receipt-run:4"))
    expect(yield* receipt.guard.status).toBe("Recorded")
    expect((yield* receipt.recording.reserve(target()).pipe(Effect.result))._tag).toBe("Failure")
    yield* receipt.close
    expect(yield* receipt.guard.status).toBe("Closed")
  }))
})

test("legacy Fresh and accepted ordinary refusals reserve no metadata", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const legacy = yield* makeToolResultReceipt(target())
    const old = yield* legacy.recording.reserve(target())
    expect(old.metadata).toEqual(Option.none())
    expect(yield* legacy.guard.status).toBe("Recording")
    const refused = yield* makeToolResultReceipt(target())
    const owner = Option.getOrThrow(yield* refused.offer.enter(target()))
    yield* owner.claim(invocationId)
    yield* owner.ready(Option.none())
    expect((yield* refused.recording.reserve(target())).metadata).toEqual(Option.none())
    const incomplete = yield* makeToolResultReceipt(target())
    yield* incomplete.offer.enter(target())
    expect((yield* incomplete.recording.reserve(target()).pipe(Effect.result))._tag).toBe("Failure")
  }))
})

test("wrong invocation or repeated ownership cannot promote a receipt", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const receipt = yield* makeToolResultReceipt(target())
    const owner = Option.getOrThrow(yield* receipt.offer.enter(target()))
    yield* owner.claim(invocationId)
    expect((yield* owner.claim(invocationId).pipe(Effect.result))._tag).toBe("Failure")
    expect((yield* owner.ready(Option.some({ invocationId: InvocationId.make("foreign") })).pipe(Effect.result))._tag).toBe("Failure")
    expect(yield* receipt.guard.status).toBe("Claimed")
    yield* owner.ready(Option.none())
    expect((yield* owner.ready(Option.none()).pipe(Effect.result))._tag).toBe("Failure")
  }))
})

test("arbitrary code sees only the same guard under offer and record scopes", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const receipt = yield* makeToolResultReceipt(target())
    const seen = yield* Effect.all([
      withToolResultReceiptGuard(CurrentToolResultReceipt).pipe(Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Offer", offer: receipt.offer }))),
      withToolResultReceiptGuard(CurrentToolResultReceipt).pipe(Effect.provideService(CurrentToolResultReceipt, Option.some({ _tag: "Record", recording: receipt.recording }))),
    ], { concurrency: 1 })
    expect(seen).toEqual([Option.some({ _tag: "Guard", guard: receipt.guard }), Option.some({ _tag: "Guard", guard: receipt.guard })])
  }))
})

test("target and accepted JSON metadata are detached before later waits", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const input = { ...target(), tool: "read" }
    const receipt = yield* makeToolResultReceipt(input)
    input.tool = "mutated"
    expect(receipt.guard.target.tool).toBe("read")
    const owner = Option.getOrThrow(yield* receipt.offer.enter(target()))
    yield* owner.claim(invocationId)
    const metadata = { invocationId, effectiveInput: { path: "rewritten" } }
    yield* owner.ready(Option.some(metadata))
    metadata.effectiveInput.path = "mutated"
    const reservation = yield* receipt.recording.reserve(target())
    expect(reservation.metadata).toEqual(Option.some({ invocationId, effectiveInput: { path: "rewritten" } }))
    expect(Option.isSome(reservation.metadata) && Object.isFrozen(reservation.metadata.value.effectiveInput)).toBe(true)
  }))
})
