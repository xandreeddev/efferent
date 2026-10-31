import { expect, test } from "bun:test"
import { Cause, Effect, Option, Schema } from "effect"
import { ModelCallData, ModelCallId } from "./model-call.entity.js"
import { recordCompletion } from "./model-call.entity.functions.js"
import { zeroUsage } from "./token-usage.entity.functions.js"
import { CurrentModelCallRecorder } from "../ports/model-call-recorder.port.js"
import { UtilityCompletion } from "../ports/utility-llm.port.js"
import { SessionLogError } from "../session/session-log.entity.js"
import { harnessError } from "../harness/harness-code.entity.functions.js"
import { isHarnessError } from "../harness/plugin.entity.functions.js"

const raw = {
  callId: "logical-call", attempt: 1, purpose: "Loop", method: "Text", model: { provider: "gateway", modelId: "invoked" },
  runId: null, run: null, step: null, durationMs: 0, usage: { _tag: "Unknown" }, outcome: { _tag: "Completed" },
} as const

test("model calls retain Unknown, genuine Known zero and Partial field presence on the wire", async () => {
  await Promise.all(([{ _tag: "Unknown" }, { _tag: "Known", usage: zeroUsage },
    { _tag: "Partial", usage: { ...zeroUsage, inputTokens: 9, totalTokens: 9 }, reported: ["inputTokens"] }] as const).map(async (usage) => {
    const wire = { ...raw, usage }
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(ModelCallData)(wire))
    expect(await Effect.runPromise(Schema.encodeEffect(ModelCallData)(decoded))).toEqual(wire)
  }))
})

test("new call counts, correlations and reported fields reject invalid stored values", async () => {
  const invalid = [
    { callId: "" }, { callId: " padded " }, { attempt: 0 }, { attempt: 1.5 }, { durationMs: -1 }, { durationMs: Infinity },
    { runId: "run", run: null }, { runId: null, run: 0 }, { step: 0 },
    { usage: { _tag: "Known", usage: { ...zeroUsage, inputTokens: -1, totalTokens: -1 } } },
    { usage: { _tag: "Known", usage: { ...zeroUsage, outputTokens: 1.5, totalTokens: 1.5 } } },
    { usage: { _tag: "Known", usage: { ...zeroUsage, totalTokens: 1 } } },
    { usage: { _tag: "Known", usage: { ...zeroUsage, cacheReadTokens: 1 } } },
    { usage: { _tag: "Known", usage: { ...zeroUsage, reasoningTokens: 1 } } },
    { usage: { _tag: "Known", usage: { ...zeroUsage, inputTokens: NaN } } },
    { usage: { _tag: "Partial", usage: zeroUsage, reported: [] } },
    { usage: { _tag: "Partial", usage: zeroUsage, reported: ["inputTokens", "inputTokens"] } },
    { usage: { _tag: "Partial", usage: zeroUsage, reported: ["totalTokens"] } },
  ]
  await Promise.all(invalid.map(async (change) => expect((await Effect.runPromise(Effect.result(Schema.decodeUnknownEffect(ModelCallData)({ ...raw, ...change }))))._tag).toBe("Failure")))
})

test("failed/interrupted outcomes can retain known usage and loop correlation", async () => {
  const call = await Effect.runPromise(Schema.decodeUnknownEffect(ModelCallData)({ ...raw, runId: "r", run: 2, step: 3,
    usage: { _tag: "Known", usage: zeroUsage }, outcome: { _tag: "Failed", failure: "ContextOverflow" } }))
  expect(Option.map(call.runId, String)).toEqual(Option.some("r"))
  expect(Option.map(call.run, Number)).toEqual(Option.some(2))
  expect(call.step).toEqual(Option.some(3))
  expect(call.outcome).toEqual({ _tag: "Failed", failure: Option.some("ContextOverflow") })
})

test("recordCompletion reads the execution-time Reference and preserves its original write failure", async () => {
  const call = await Effect.runPromise(Schema.decodeUnknownEffect(ModelCallData)(raw))
  const invoked: string[] = []
  const operation = recordCompletion(call)
  await Effect.runPromise(operation)
  await Effect.runPromise(operation.pipe(Effect.provideService(CurrentModelCallRecorder, { record: () => Effect.sync(() => { invoked.push("one") }) })))
  await Effect.runPromise(operation.pipe(Effect.provideService(CurrentModelCallRecorder, { record: () => Effect.sync(() => { invoked.push("two") }) })))
  const failure = new SessionLogError({ code: "session.write", message: "write refused" })
  const result = await Effect.runPromise(Effect.result(operation.pipe(Effect.provideService(CurrentModelCallRecorder, { record: () => Effect.fail(failure) }))))
  expect(invoked).toEqual(["one", "two"])
  expect(result._tag === "Failure" && result.failure === failure).toBe(true)
  expect(ModelCallId.make("logical-call")).toBe(call.callId)
})

test("UtilityCompletion preserves old constructors and structural host stubs", () => {
  const old: UtilityCompletion = { text: "opaque", usage: zeroUsage }
  const constructed = new UtilityCompletion({ text: "opaque", usage: zeroUsage })
  expect([old.text, constructed.text, Object.hasOwn(constructed, "model")]).toEqual(["opaque", "opaque", false])
})

test("recordCompletion preserves original TurnErrors carried as recorder defects", async () => {
  const call = await Effect.runPromise(Schema.decodeUnknownEffect(ModelCallData)(raw))
  await Promise.all([
    new SessionLogError({ code: "session.write", message: "write refused" }),
    harnessError("events.depth", "notification reentered"),
  ].map(async (failure) => {
    const result = await Effect.runPromise(Effect.result(recordCompletion(call).pipe(
      Effect.provideService(CurrentModelCallRecorder, { record: () => Effect.die(failure) }),
    )))
    expect(result._tag === "Failure" && result.failure === failure).toBe(true)
  }))
})

test("recordCompletion contains unexpected recorder defects with a fixed message and original cause", async () => {
  const call = await Effect.runPromise(Schema.decodeUnknownEffect(ModelCallData)(raw))
  const defect = new Error("unexpected recorder defect")
  const result = await Effect.runPromise(Effect.result(recordCompletion(call).pipe(
    Effect.provideService(CurrentModelCallRecorder, { record: () => Effect.die(defect) }),
  )))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure" && isHarnessError(result.failure)) {
    expect(result.failure.code).toBe("turn.defect")
    expect(result.failure.message).toBe("The model call could not be recorded.")
    expect(result.failure.cause).toBe(defect)
  } else {
    expect(false).toBe(true)
  }
})

test("recordCompletion leaves recorder interruption as interruption", async () => {
  const call = await Effect.runPromise(Schema.decodeUnknownEffect(ModelCallData)(raw))
  const exit = await Effect.runPromiseExit(recordCompletion(call).pipe(
    Effect.provideService(CurrentModelCallRecorder, { record: () => Effect.interrupt }),
  ))
  expect(exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
})

test("recordCompletion contains a synchronous defect invoking a host recorder", async () => {
  const call = await Effect.runPromise(Schema.decodeUnknownEffect(ModelCallData)(raw))
  const defect = new Error("synchronous host recorder defect")
  const result = await Effect.runPromise(Effect.result(recordCompletion(call).pipe(
    Effect.provideService(CurrentModelCallRecorder, { record: () => Effect.runSync(Effect.die(defect)) }),
  )))
  expect(result._tag === "Failure" && isHarnessError(result.failure) && result.failure.cause === defect).toBe(true)
})
