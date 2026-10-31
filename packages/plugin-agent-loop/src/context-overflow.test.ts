import { expect, test } from "bun:test"
import { AiError, LanguageModel, Prompt, Toolkit } from "effect/ai"
import type { Response } from "effect/ai"
import { Effect, Option, Ref, Stream } from "effect"
import { harnessCodeOf, stampAiErrorFailure } from "@xandreed/core"
import type { LoopEvent } from "./loop-event.entity.js"
import { runLoop } from "./loop.js"

const overflow = stampAiErrorFailure(AiError.make({ module: "Fixture", method: "request", reason: new AiError.InvalidRequestError({ description: "context rejected" }) }), "ContextOverflow")
const image = AiError.make({ module: "Fixture", method: "request", reason: new AiError.InvalidRequestError({ description: "image rejected" }) })
const transient = AiError.make({ module: "Fixture", method: "streamText", reason: new AiError.InternalProviderError({ description: "unavailable" }) })
const done: Array<Response.PartEncoded> = [{ type: "text", text: "done" }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 12 }, outputTokens: { total: 2 } } }]

test("overflow after stream fallback keeps settled mode and frozen choices while rendering a new request", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const generated = yield* Ref.make(0)
    const streamed = yield* Ref.make(0)
    const plans = yield* Ref.make(0)
    const directives = yield* Ref.make(0)
    const recoveries = yield* Ref.make(0)
    const renders = yield* Ref.make(0)
    const dispatched = yield* Ref.make<ReadonlyArray<string>>([])
    const events = yield* Ref.make<ReadonlyArray<LoopEvent>>([])
    const model = yield* LanguageModel.make({
      generateText: () => Ref.getAndUpdate(generated, count => count + 1).pipe(Effect.flatMap(count => count === 0 ? Effect.fail(overflow) : Effect.succeed(done))),
      streamText: () => Stream.unwrap(Ref.update(streamed, count => count + 1).pipe(Effect.as(Stream.fail(transient)))),
    })
    yield* runLoop({
      system: "original", messages: [], toolkit: Toolkit.make(), streaming: true,
      prepareModel: () => Ref.update(plans, count => count + 1).pipe(Effect.as({ model, system: Prompt.make([{ role: "system", content: "frozen system" }]) })),
      stepDirective: () => Ref.update(directives, count => count + 1).pipe(Effect.as({ toolChoice: Option.none() })),
      render: () => Ref.update(renders, count => count + 1).pipe(Effect.andThen(Ref.get(recoveries)), Effect.map(count => [{ role: "user", content: count === 0 ? "large old context" : "kept" }])),
      beforeDispatch: (_step, actual) => Ref.update(dispatched, all => [...all, JSON.stringify(actual.prompt.content)]),
      onContextOverflow: () => Ref.update(recoveries, count => count + 1).pipe(Effect.as(true)),
      onEvent: event => Ref.update(events, all => [...all, event]),
    }).pipe(Effect.provideService(LanguageModel.LanguageModel, model))
    return { generated: yield* Ref.get(generated), streamed: yield* Ref.get(streamed), plans: yield* Ref.get(plans), directives: yield* Ref.get(directives), recoveries: yield* Ref.get(recoveries), renders: yield* Ref.get(renders), dispatched: yield* Ref.get(dispatched), events: yield* Ref.get(events) }
  }))
  expect([result.generated, result.streamed, result.plans, result.directives, result.recoveries, result.renders]).toEqual([2, 1, 1, 1, 1, 2])
  expect(result.dispatched).toHaveLength(3)
  expect(result.dispatched[0]).toBe(result.dispatched[1])
  expect(result.dispatched[2]).not.toBe(result.dispatched[1])
  expect(result.dispatched.every(prompt => prompt.includes("frozen system"))).toBe(true)
  expect(result.events.filter(event => event.type === "stream_fallback")).toHaveLength(1)
})

test.each([{ errors: [image, overflow, image] }, { errors: [overflow, image, overflow] }])("media and overflow recoveries do not rearm each other (%p)", async ({ errors }) => {
  const observed = await Effect.runPromise(Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const media = yield* Ref.make(0)
    const recovered = yield* Ref.make(0)
    const records = yield* Ref.make(0)
    const model = yield* LanguageModel.make({
      generateText: () => Ref.getAndUpdate(calls, count => count + 1).pipe(Effect.flatMap(count => Effect.fail(errors[count] ?? overflow))),
      streamText: () => Stream.die("not scripted"),
    })
    const result = yield* Effect.result(runLoop({
      system: "fixture", messages: [], toolkit: Toolkit.make(),
      onMediaRejected: () => Ref.update(media, count => count + 1).pipe(Effect.as(true)),
      onContextOverflow: () => Ref.update(recovered, count => count + 1).pipe(Effect.as(true)),
      onTail: () => Ref.update(records, count => count + 1).pipe(Effect.as([])),
    }).pipe(Effect.provideService(LanguageModel.LanguageModel, model)))
    return { result, calls: yield* Ref.get(calls), media: yield* Ref.get(media), recovered: yield* Ref.get(recovered), records: yield* Ref.get(records) }
  }))
  expect([observed.calls, observed.media, observed.recovered, observed.records]).toEqual([3, 1, 1, 0])
  expect(observed.result._tag === "Failure" ? observed.result.failure : undefined).toBe(errors[2])
})

test.each(["render", "dispatch", "fallback-event"] as const)("a callback's overflow-shaped AiError at %s never authorizes recovery", async stage => {
  const observed = await Effect.runPromise(Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const recoveries = yield* Ref.make(0)
    const model = yield* LanguageModel.make({
      generateText: () => Ref.update(calls, count => count + 1).pipe(Effect.as(done)),
      streamText: () => Stream.unwrap(Ref.update(calls, count => count + 1).pipe(Effect.as(Stream.fail(transient)))),
    })
    const result = yield* Effect.result(runLoop({
      system: "fixture", messages: [], toolkit: Toolkit.make(), streaming: stage === "fallback-event",
      render: () => stage === "render" ? Effect.fail(overflow) : Effect.succeed([]),
      beforeDispatch: () => stage === "dispatch" ? Effect.fail(overflow) : Effect.void,
      onEvent: event => stage === "fallback-event" && event.type === "stream_fallback" ? Effect.fail(overflow) : Effect.void,
      onContextOverflow: () => Ref.update(recoveries, count => count + 1).pipe(Effect.as(true)),
    }).pipe(Effect.provideService(LanguageModel.LanguageModel, model)))
    return { result, calls: yield* Ref.get(calls), recoveries: yield* Ref.get(recoveries) }
  }))
  expect(observed.result._tag === "Failure" ? observed.result.failure : undefined).toBe(overflow)
  expect([observed.calls, observed.recoveries]).toEqual([stage === "fallback-event" ? 1 : 0, 0])
})

test.each(["silent", "empty-delta", "empty-tool-start", "visible"] as const)("a stamped streamed error after %s respects actual delta visibility", async mode => {
  const observed = await Effect.runPromise(Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const recoveries = yield* Ref.make(0)
    const records = yield* Ref.make(0)
    const failed: ReadonlyArray<Response.StreamPartEncoded> = [
      { type: "response-metadata", id: "silent", modelId: "opaque" },
      ...(mode === "silent" ? [] : mode === "empty-tool-start" ? [{ type: "tool-params-start" as const, id: "call", name: "probe" }] : [{ type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: mode === "visible" ? "visible" : "" }]),
      { type: "error", error: { opaque: true }, metadata: { engine: { failure: "ContextOverflow" } } },
    ]
    const model = yield* LanguageModel.make({
      generateText: () => Effect.die("settled fallback must not run"),
      streamText: () => Stream.unwrap(Ref.getAndUpdate(calls, count => count + 1).pipe(Effect.map(count => Stream.fromIterable(count === 0 ? failed : [{ type: "finish", reason: "stop", usage: { inputTokens: { total: 12 }, outputTokens: { total: 0 } } }])))),
    })
    const result = yield* Effect.result(runLoop({
      system: "fixture", messages: [], toolkit: Toolkit.make(), streaming: true,
      onContextOverflow: () => Ref.update(recoveries, count => count + 1).pipe(Effect.as(true)),
      onTail: () => Ref.update(records, count => count + 1).pipe(Effect.as([])),
    }).pipe(Effect.provideService(LanguageModel.LanguageModel, model)))
    return { result, calls: yield* Ref.get(calls), recoveries: yield* Ref.get(recoveries), records: yield* Ref.get(records) }
  }))
  expect([observed.calls, observed.recoveries, observed.records]).toEqual(mode === "visible" ? [1, 0, 0] : [2, 1, 1])
  expect(observed.result._tag === "Failure" ? Option.getOrNull(harnessCodeOf(observed.result.failure)) : "completed").toBe(mode === "visible" ? "model.context-overflow" : "completed")
})

test.each(["render", "dispatch", "overflow-hook", "media-hook", "fallback-event", "delta"] as const)("a malformed-shaped callback failure at %s retains identity without corrective or replay", async stage => {
  const failure = AiError.make({ module: "Host", method: stage, reason: new AiError.InvalidOutputError({ description: "host callback refused" }) })
  const observed = await Effect.runPromise(Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const records = yield* Ref.make(0)
    const model = yield* LanguageModel.make({
      generateText: () => Ref.update(calls, count => count + 1).pipe(Effect.andThen(stage === "overflow-hook" ? Effect.fail(overflow) : stage === "media-hook" ? Effect.fail(image) : Effect.succeed(done))),
      streamText: () => Stream.unwrap(Ref.update(calls, count => count + 1).pipe(Effect.as(stage === "delta"
        ? Stream.fromIterable<Response.StreamPartEncoded>([{ type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: "visible" }]) : Stream.fail(transient)))),
    })
    const result = yield* Effect.result(runLoop({
      system: "fixture", messages: [], toolkit: Toolkit.make(), streaming: stage === "fallback-event" || stage === "delta",
      render: () => stage === "render" ? Effect.fail(failure) : Effect.succeed([]),
      beforeDispatch: () => stage === "dispatch" ? Effect.fail(failure) : Effect.void,
      onContextOverflow: () => Effect.fail(failure),
      onMediaRejected: () => Effect.fail(failure),
      onEvent: event => (stage === "fallback-event" && event.type === "stream_fallback") || (stage === "delta" && event.type === "assistant_delta") ? Effect.fail(failure) : Effect.void,
      onTail: () => Ref.update(records, count => count + 1).pipe(Effect.as([])),
    }).pipe(Effect.provideService(LanguageModel.LanguageModel, model)))
    return { result, calls: yield* Ref.get(calls), records: yield* Ref.get(records) }
  }))
  expect(observed.result._tag === "Failure" ? observed.result.failure : undefined).toBe(failure)
  expect([observed.calls, observed.records]).toEqual([stage === "render" || stage === "dispatch" ? 0 : 1, 0])
})
