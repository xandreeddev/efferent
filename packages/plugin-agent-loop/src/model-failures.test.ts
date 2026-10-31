import { describe, expect, test } from "bun:test"
import { AiError, LanguageModel, Tool, Toolkit } from "effect/ai"
import type { Response } from "effect/ai"
import { Effect, Option, Ref, Schema, Stream } from "effect"
import { HarnessError, harnessDefectsAsFailures, modelFailureCodeOf, modelFailureOf, stampAiErrorFailure } from "@xandreed/core"
import type { AgentMessage, ModelFailureKind, StepStatus } from "@xandreed/core"
import type { LoopEvent } from "./loop-event.entity.js"
import { runLoop } from "./loop.js"

const Probe = Tool.make("failure_probe", { description: "Return a number.", parameters: Schema.Struct({ n: Schema.Number }), success: Schema.Number })
const kit = Toolkit.make(Probe)
const finish = { type: "finish" as const, reason: "stop" as const, usage: { inputTokens: { total: 4 }, outputTokens: { total: 1 } } }
const done: ReadonlyArray<Response.PartEncoded> = [{ type: "text", text: "done" }, finish]
const streamedDone: ReadonlyArray<Response.StreamPartEncoded> = [
  { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "done" }, { type: "text-end", id: "text" }, finish,
]

const run = (scenario: {
  readonly content?: ReadonlyArray<Response.PartEncoded>
  readonly stream?: ReadonlyArray<Response.StreamPartEncoded>
  readonly failure?: AiError.AiError
  readonly streaming?: boolean
  readonly failureAfterDeltas?: boolean
}) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const settledCalls = yield* Ref.make(0)
  const streamedCalls = yield* Ref.make(0)
  const handled = yield* Ref.make(0)
  const recorded = yield* Ref.make<ReadonlyArray<AgentMessage>>([])
  const events = yield* Ref.make<ReadonlyArray<LoopEvent>>([])
  const statuses = yield* Ref.make<ReadonlyArray<StepStatus>>([])
  const handlers = yield* kit.toHandlers({ failure_probe: ({ n }) => Ref.update(handled, (count) => count + 1).pipe(Effect.as(n)) })
  const model = yield* LanguageModel.make({
    generateText: () => Ref.getAndUpdate(settledCalls, (count) => count + 1).pipe(Effect.flatMap((index) => scenario.failure !== undefined && scenario.streaming !== true
      ? Effect.fail(scenario.failure) : Effect.succeed([...(index === 0 ? scenario.content ?? done : done)]))),
    streamText: () => Stream.unwrap(Ref.update(streamedCalls, (count) => count + 1).pipe(Effect.as(
      scenario.failure !== undefined
        ? Stream.concat(scenario.failureAfterDeltas === true ? Stream.fromIterable<Response.StreamPartEncoded>([
          { type: "tool-params-start", id: "unfinished", name: Probe.name }, { type: "tool-params-delta", id: "unfinished", delta: '{"n":' },
        ]) : Stream.empty, Stream.fail(scenario.failure))
        : Stream.fromIterable(scenario.stream ?? streamedDone),
    ))),
  })
  const result = yield* Effect.result(runLoop({
    system: "fixture", messages: [{ role: "user", content: "go" }], toolkit: kit, maxSteps: 4,
    streaming: scenario.streaming ?? false,
    onTail: (tail) => Ref.update(recorded, (all) => [...all, ...tail]).pipe(Effect.as([])),
    onEvent: (event) => Ref.update(events, (all) => [...all, event]),
    onStepSettled: (_step, status) => Ref.update(statuses, (all) => [...all, status]),
  }).pipe(Effect.provide(handlers), Effect.provideService(LanguageModel.LanguageModel, model)))
  return { result, settledCalls: yield* Ref.get(settledCalls), streamedCalls: yield* Ref.get(streamedCalls), handled: yield* Ref.get(handled), recorded: yield* Ref.get(recorded), events: yield* Ref.get(events), statuses: yield* Ref.get(statuses) }
})))

const failures: ReadonlyArray<readonly [ModelFailureKind, string]> = [
  ["ContextOverflow", "The model request exceeded the context limit."],
  ["Authentication", "The model request could not be authenticated."],
  ["InvalidRequest", "The model request was rejected."],
  ["RateLimit", "The model request was rate limited."],
  ["Quota", "The model request exceeded the available quota."],
  ["Transient", "The model service is temporarily unavailable."],
  ["InvalidResponse", "The model returned an invalid response."],
  ["Timeout", "The model request timed out."],
  ["Unknown", "The model request failed."],
]

describe("semantic model failures before the response gate", () => {
  test("a recorder TurnError before the first streamed part fails without a settled fallback", async () => {
    const failure = new HarnessError({ code: "events.encode", message: "the model call could not be recorded" })
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const settled = yield* Ref.make(0)
      const events = yield* Ref.make<ReadonlyArray<LoopEvent>>([])
      const model = yield* LanguageModel.make({
        generateText: () => Ref.update(settled, (count) => count + 1).pipe(Effect.as([...done])),
        streamText: () => Stream.die(failure),
      })
      const result = yield* Effect.result(harnessDefectsAsFailures(runLoop({
        system: "fixture", messages: [{ role: "user", content: "go" }],
        toolkit: Toolkit.make(), maxSteps: 2, streaming: true,
        onEvent: (event) => Ref.update(events, (all) => [...all, event]),
      }).pipe(Effect.provideService(LanguageModel.LanguageModel, model))))
      return { result, settled: yield* Ref.get(settled), events: yield* Ref.get(events) }
    }))
    expect(observed.result._tag === "Failure" ? observed.result.failure : undefined).toBe(failure)
    expect(observed.settled).toBe(0)
    expect(observed.events.some((event) => event.type === "stream_fallback" || event.type === "assistant_message")).toBe(false)
  })

  failures.map(([kind, message]) => test(`${kind} in an otherwise executable response fails before recording or tools`, async () => {
    const content: ReadonlyArray<Response.PartEncoded> = [
      { type: "tool-call", id: "", name: Probe.name, params: { n: 1 }, providerExecuted: false },
      { ...finish, reason: "length", metadata: { engine: { failure: kind } } },
    ]
    const observed = await run({ content })
    expect(observed.result._tag).toBe("Failure")
    if (observed.result._tag !== "Failure") return
    const error = observed.result.failure
    expect(error._tag === "HarnessError" ? error.code : error._tag).toBe(modelFailureCodeOf(kind))
    expect(error.message).toBe(message)
    expect(error._tag === "HarnessError" ? error.cause : undefined).toMatchObject({ content })
    expect([observed.handled, observed.recorded.length, observed.settledCalls]).toEqual([0, 0, 1])
    expect(observed.statuses).toEqual(["failed"])
    expect(observed.events.some((event) => event.type === "assistant_message" || event.type === "stream_fallback")).toBe(false)
  }))

  test.each(["ContextOverflow", "Authentication", "InvalidRequest", "Quota", "InvalidResponse"] as const)("a pre-first-part permanent %s error bypasses settled fallback", async (kind) => {
    const failure = stampAiErrorFailure(AiError.make({ module: "Fixture", method: "streamText", reason: new AiError.UnknownError({ description: "original failure" }) }), kind)
    const observed = await run({ failure, streaming: true })
    expect(observed.result._tag === "Failure" ? observed.result.failure : undefined).toBe(failure)
    expect([observed.streamedCalls, observed.settledCalls, observed.handled, observed.recorded.length]).toEqual([1, 0, 0, 0])
    expect(observed.statuses).toEqual(["failed"])
    expect(observed.events.some((event) => event.type === "stream_fallback")).toBe(false)
  })

  test.each(["Transient", "RateLimit", "Timeout", "Unknown"] as const)("a pre-first-part %s error retains the existing settled fallback", async (kind) => {
    const failure = stampAiErrorFailure(AiError.make({ module: "Fixture", method: "streamText", reason: new AiError.UnknownError({ description: "original failure" }) }), kind)
    const observed = await run({ failure, streaming: true })
    expect(observed.result._tag).toBe("Success")
    expect([observed.streamedCalls, observed.settledCalls]).toEqual([1, 1])
    expect(observed.events.filter((event) => event.type === "stream_fallback")).toHaveLength(1)
  })

  test.each([false, true])("a stamped protocol InvalidOutputError bypasses malformed correction (after deltas %p)", async (afterDeltas) => {
    const failure = stampAiErrorFailure(AiError.make({ module: "Fixture", method: "generateText", reason: new AiError.InvalidOutputError({ description: "protocol decode", usage: { promptTokens: 4 } }) }), "InvalidResponse")
    const observed = await run({ failure, streaming: afterDeltas, failureAfterDeltas: afterDeltas })
    expect(observed.result._tag === "Failure" ? observed.result.failure : undefined).toBe(failure)
    expect(modelFailureOf(failure)).toEqual(Option.some("InvalidResponse"))
    expect([observed.handled, observed.recorded.length, observed.settledCalls + observed.streamedCalls]).toEqual([0, 0, 1])
    expect(observed.statuses).toEqual(["failed"])
    expect(observed.events.some((event) => event.type === "stream_fallback")).toBe(false)
  })

  test.each(["Transient", "RateLimit", "Timeout", "Unknown"] as const)("an explicit %s InvalidOutputError also bypasses malformed correction", async (kind) => {
    const failure = stampAiErrorFailure(AiError.make({ module: "Fixture", method: "generateText", reason: new AiError.InvalidOutputError({ description: "stamped failure" }) }), kind)
    const observed = await run({ failure })
    expect(observed.result._tag === "Failure" ? observed.result.failure : undefined).toBe(failure)
    expect([observed.settledCalls, observed.handled, observed.recorded.length]).toEqual([1, 0, 0])
    expect(observed.statuses).toEqual(["failed"])
  })

  test("a stamped streamed error part after tool-argument deltas fails before recording or handlers", async () => {
    const observed = await run({ streaming: true, stream: [
      { type: "tool-params-start", id: "unfinished", name: Probe.name },
      { type: "tool-params-delta", id: "unfinished", delta: '{"n":' },
      { type: "error", error: { opaque: "exact original data" }, metadata: { engine: { failure: "ContextOverflow" } } },
    ] })
    expect(observed.result._tag === "Failure" && observed.result.failure._tag === "HarnessError" ? observed.result.failure.code : "passed").toBe("model.context-overflow")
    expect([observed.streamedCalls, observed.settledCalls, observed.handled, observed.recorded.length]).toEqual([1, 0, 0, 0])
    expect(observed.statuses).toEqual(["failed"])
    expect(observed.events.flatMap((event) => event.type === "assistant_delta" ? [event.delta] : [])).toEqual(["", '{"n":'])
    expect(observed.events.some((event) => event.type === "stream_fallback" || event.type === "assistant_message")).toBe(false)
  })
})
