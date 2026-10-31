import { expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { ModelCallData, ModelCallId } from "../domain/model-call.entity.js"
import { ConversationId } from "../domain/message.entity.js"
import { zeroUsage } from "../domain/token-usage.entity.functions.js"
import { entriesOfEvents, turnBilledUsageOf, turnModelCallsOf, turnUsageOf } from "./session-event.entity.functions.js"
import type { SessionLogEvent } from "./session-log.entity.js"

const usage = { ...zeroUsage, inputTokens: 10, outputTokens: 2, totalTokens: 12 }
const call = (id: string, counts: ModelCallData["usage"]): ModelCallData => ({ callId: ModelCallId.make(id), attempt: 1,
  purpose: "Helper", method: "Text", model: Option.none(), runId: Option.none(), run: Option.none(), step: Option.none(), durationMs: 1,
  usage: counts, outcome: { _tag: "Completed" } })
const event = (kind: string, data: SessionLogEvent["data"], seq = 1, turn = 4): SessionLogEvent => ({
  session: ConversationId.make("00000000-0000-4000-8000-000000008888"), turn: Option.some(turn), kind, seq, at: 0, data,
})
const recorded = (data: ModelCallData, seq = 1, turn = 4) => Schema.encodeEffect(ModelCallData)(data).pipe(Effect.map((wire) => event("model.called", wire, seq, turn)))
const legacy = event("step.usage", { step: 0, run: 0, model: "legacy:model", usage })

test("billed usage selects ledger facts, including helpers and partial failed attempts, without selected-response double counting", async () => {
  const events = [legacy, await Effect.runPromise(recorded(call("known", { _tag: "Known", usage }))),
    await Effect.runPromise(recorded({ ...call("partial", { _tag: "Partial", usage: { ...zeroUsage, inputTokens: 3, totalTokens: 3 }, reported: ["inputTokens"] }), outcome: { _tag: "Interrupted" } }, 2)),
    await Effect.runPromise(recorded(call("other-turn", { _tag: "Known", usage }), 3, 5))]
  expect(await Effect.runPromise(turnBilledUsageOf(events, 4))).toEqual({ ...usage, inputTokens: 13, totalTokens: 15 })
  expect((await Effect.runPromise(turnModelCallsOf(events, 4))).map((row) => String(row.callId))).toEqual(["known", "partial"])
  expect(await Effect.runPromise(turnUsageOf(events, 4))).toEqual(usage)
  expect(await Effect.runPromise(entriesOfEvents(events.filter((row) => row.kind === "model.called")))).toEqual([])
})

test("Unknown-only and Known-zero ledgers suppress even malformed legacy selected usage", async () => {
  await Promise.all([{ _tag: "Unknown" } as const, { _tag: "Known", usage: zeroUsage } as const].map(async (counts) => {
    const events = [event("step.usage", { malformed: true }), await Effect.runPromise(recorded(call("coverage", counts)))]
    expect(await Effect.runPromise(turnBilledUsageOf(events, 4))).toEqual(zeroUsage)
  }))
  expect(await Effect.runPromise(turnBilledUsageOf([legacy], 4))).toEqual(usage)
  expect(await Effect.runPromise(turnBilledUsageOf([], 4))).toEqual(zeroUsage)
})

test("both readers reject identical duplicate attempt keys and malformed ledger rows instead of falling back", async () => {
  const first = await Effect.runPromise(recorded(call("duplicate", { _tag: "Unknown" })))
  const readers: ReadonlyArray<(events: ReadonlyArray<SessionLogEvent>, turn: number) => Effect.Effect<unknown, Schema.SchemaError>> = [turnModelCallsOf, turnBilledUsageOf]
  await Promise.all(readers.map(async (read) => {
    expect((await Effect.runPromise(Effect.result(read([first, { ...first, seq: 2 }], 4))))._tag).toBe("Failure")
    expect((await Effect.runPromise(Effect.result(read([legacy, event("model.called", { callId: "bad" })], 4))))._tag).toBe("Failure")
  }))
})

test("a ledger subtotal cannot overflow into an unsafe billed count", async () => {
  const huge = { ...zeroUsage, inputTokens: Number.MAX_SAFE_INTEGER, totalTokens: Number.MAX_SAFE_INTEGER }
  const rows = await Promise.all(["one", "two"].map((id) => Effect.runPromise(recorded(call(id, { _tag: "Known", usage: huge })))))
  expect((await Effect.runPromise(Effect.result(turnBilledUsageOf(rows, 4))))._tag).toBe("Failure")
})
