import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Redacted, Ref, Schema, Stream } from "effect"
import { CurrentModelCallRecorder, ModelId, harnessCodeOf, harnessError, isHarnessError, isTurnError, parseModelSelection } from "@xandreed/core"
import { FetchHttpClient } from "effect/http"
import { buildProvider } from "./providers.js"
import type { ModelCallData } from "@xandreed/core"
import { makeCompatLanguageModel } from "./compat.js"
import { beginModelAttempt, completeModelAttempt, completePendingAttempts, makeCompletionCall, observeModelAttempt } from "./model-completion.adapter.js"

const config = { moduleName: "fixture", model: "actual", chatUrl: "https://fixture.invalid/chat/completions" }
const completed = (usage: unknown = { prompt_tokens: 9, completion_tokens: 2 }, content = "ok") => ({ choices: [{ finish_reason: "stop", message: { content } }], usage })
const capture = <A, E>(operation: Effect.Effect<A, E>) => {
  const records: Array<ModelCallData> = []
  return Effect.runPromise(Effect.exit(operation).pipe(Effect.provideService(CurrentModelCallRecorder, { record: data => Effect.sync(() => { records.push(data) }) }), Effect.map(exit => ({ records, exit }))))
}

describe("model completion capability", () => {
  test.each([false, true])("native Responses streaming=%s retains inclusive cache-write usage in the ledger", async (streaming) => {
    const payload = {
      id: "resp_accounting", object: "response", model: "gpt-5.5", created_at: 0, status: "completed",
      output: [{ type: "message", id: "msg_accounting", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }],
      usage: { input_tokens: 35, output_tokens: 8, total_tokens: 43, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 }, output_tokens_details: { reasoning_tokens: 3 } },
    }
    const { records, exit } = await capture(Effect.scoped(Effect.gen(function* () {
      const selection = yield* Effect.fromOption(parseModelSelection("openai:gpt-5.5"))
      const { svc } = yield* buildProvider(selection, undefined, Redacted.make("fixture-private-key"))
      return yield* (streaming ? Stream.runDrain(svc.streamText({ prompt: "inspect usage" })) : svc.generateText({ prompt: "inspect usage" }).pipe(Effect.asVoid))
    })).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, Object.assign(async () => streaming
      ? new Response(`data: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(payload), { preconnect: () => undefined }))))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(records).toHaveLength(1)
    expect(records[0]?.usage).toEqual({ _tag: "Known", usage: { inputTokens: 35, outputTokens: 8, totalTokens: 43, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 3 } })
    expect(records[0]?.outcome).toEqual({ _tag: "Completed" })
  })
  test("normal, empty and unknown provider completions record once before consumer acceptance", async () => {
    const { records, exit } = await capture(Effect.forEach([
      completed({ prompt_tokens: 0, completion_tokens: 0 }),
      completed({ prompt_tokens: 9, completion_tokens: 2 }, ""),
      { choices: [{ finish_reason: "stop", message: { content: "unknown usage" } }] },
    ], body => Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => Response.json(body) })
      return yield* model.generateText({ prompt: "inspect" })
    }), { concurrency: 1 }))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(records.map(data => [data.method, data.usage._tag, data.outcome._tag])).toEqual([["Text", "Known", "Completed"], ["Text", "Known", "Completed"], ["Text", "Unknown", "Completed"]])
    expect(records[0]?.usage).toEqual({ _tag: "Known", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })
    expect(records.every(data => Option.exists(data.model, value => value.provider === "fixture" && value.modelId === "actual"))).toBe(true)
  })
  test("malformed tool arguments and object-schema rejection retain raw known usage without duplicate records", async () => {
    const malformed = await capture(Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "call_fixture", type: "function", function: { name: "fixture", arguments: "{" } }] } }], usage: { prompt_tokens: 9, completion_tokens: 2 } }) })
      return yield* model.generateText({ prompt: "inspect" })
    }))
    expect(Exit.isFailure(malformed.exit)).toBe(true)
    expect(malformed.records.map(data => [data.usage._tag, data.outcome._tag])).toEqual([["Known", "Completed"]])
    const object = await capture(Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => Response.json(completed({ prompt_tokens: 9, completion_tokens: 2 }, '{"ok":"wrong type"}')) })
      return yield* model.generateObject({ prompt: "inspect", schema: Schema.Struct({ ok: Schema.Boolean }) })
    }))
    expect(Exit.isFailure(object.exit)).toBe(true)
    expect(object.records.map(data => [data.method, data.usage._tag, data.outcome._tag])).toEqual([["Object", "Known", "Completed"]])
  })
  test("a host response replacement cannot replace actual provider usage", async () => {
    const { records, exit } = await capture(Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => Response.json(completed()), aroundRequest: (_body, request) => request.pipe(Effect.as(Response.json(completed({ prompt_tokens: 100, completion_tokens: 50 }, "host replacement")))) })
      return yield* model.generateText({ prompt: "inspect" })
    }))
    expect(Exit.isSuccess(exit) && exit.value.text).toBe("host replacement")
    expect(records).toHaveLength(1)
    expect(records[0]?.usage).toEqual({ _tag: "Known", usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })
  })
  test("a child called after parent handoff has a new id and actual model", async () => {
    const { records, exit } = await capture(Effect.gen(function* () {
      const child = yield* makeCompatLanguageModel({ ...config, model: "child", fetchImpl: async () => Response.json(completed()) })
      const parent = yield* makeCompatLanguageModel({ ...config, model: "parent", fetchImpl: async () => Response.json(completed()), aroundRequest: (_body, request) => request.pipe(Effect.tap(() => child.generateText({ prompt: "child" }))) })
      return yield* parent.generateText({ prompt: "parent" })
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(records.map(data => Option.map(data.model, value => value.modelId))).toEqual([Option.some(ModelId.make("parent")), Option.some(ModelId.make("child"))])
    expect(new Set(records.map(data => data.callId)).size).toBe(2)
    expect(records.map(data => data.attempt)).toEqual([1, 1])
  })
  test("a committed append with a lost ACK has one sticky failure across terminal owners", async () => {
    const expected = harnessError("session.log", "fixture lost ACK")
    const records: Array<ModelCallData> = []
    const found = await Effect.runPromise(Effect.gen(function* () {
      const call = yield* makeCompletionCall()
      const attempt = yield* beginModelAttempt(call, 1, "compat")
      yield* observeModelAttempt(attempt, { prompt_tokens: 9, completion_tokens: 2 }, true)
      const first = yield* Effect.flip(completeModelAttempt(attempt, { _tag: "Completed" }))
      const second = yield* Effect.flip(completeModelAttempt(attempt, { _tag: "Failed", failure: Option.none() }))
      const cleanup = yield* Effect.flip(completePendingAttempts(call, Exit.succeed(undefined)))
      return [first, second, cleanup]
    }).pipe(Effect.provideService(CurrentModelCallRecorder, { record: data => Effect.sync(() => records.push(data)).pipe(Effect.andThen(Effect.fail(expected))) })))
    expect(found).toEqual([expected, expected, expected])
    expect(found.every(error => error === expected)).toBe(true)
    expect(records).toHaveLength(1)
    expect(records[0]?.outcome).toEqual({ _tag: "Completed" })
  })
  test("concurrent terminal owners await the same single recorder ACK", async () => {
    const records: Array<ModelCallData> = []
    await Effect.runPromise(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const call = yield* makeCompletionCall()
      const attempt = yield* beginModelAttempt(call, 1, "compat")
      const recorder = { record: (data: ModelCallData) => Effect.sync(() => records.push(data)).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Deferred.await(release))) }
      // The capability captures its recorder at dispatch.
      const secondAttempt = yield* beginModelAttempt(call, 2, "compat").pipe(Effect.provideService(CurrentModelCallRecorder, recorder))
      const first = yield* Effect.forkChild(completeModelAttempt(secondAttempt, { _tag: "Completed" }))
      yield* Deferred.await(entered)
      const other = yield* Effect.forkChild(completeModelAttempt(secondAttempt, { _tag: "Interrupted" }))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(other)
      yield* completeModelAttempt(attempt, { _tag: "Completed" })
    }).pipe(Effect.timeout("2 seconds")))
    expect(records.map(data => [data.attempt, data.outcome._tag])).toEqual([[2, "Completed"]])
  })
  test("early downstream stop records a partial Interrupted stream once", async () => {
    const cancelled: Array<boolean> = []
    const { records, exit } = await capture(Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }], usage: { prompt_tokens: 31, completion_tokens: 0 } })}\n\n`)) }, cancel() { cancelled.push(true) } }), { headers: { "content-type": "text/event-stream" } }) })
      return yield* Stream.runCollect(model.streamText({ prompt: "inspect" }).pipe(Stream.take(1)))
    }))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(records.map(data => [data.method, data.usage._tag, data.outcome._tag])).toEqual([["Stream", "Partial", "Interrupted"]])
    expect(cancelled).toEqual([true])
  })
  test("a stream finalizer recorder failure stays the original observable defect", async () => {
    const expected = harnessError("session.log", "fixture stream recorder failed")
    const writes: Array<ModelCallData> = []
    const exit = await Effect.runPromise(Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')) } }), { headers: { "content-type": "text/event-stream" } }) })
      return yield* Stream.runCollect(model.streamText({ prompt: "inspect" }).pipe(Stream.take(1)))
    }).pipe(Effect.provideService(CurrentModelCallRecorder, { record: data => Effect.sync(() => writes.push(data)).pipe(Effect.andThen(Effect.fail(expected))) }), Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(expected)
    expect(writes).toHaveLength(1)
  })
  test("an unexpected recorder defect before the first stream part remains a terminal recorder failure", async () => {
    const expected = new Error("fixture unexpected recorder defect")
    const sends: Array<number> = []
    const writes: Array<ModelCallData> = []
    const exit = await Effect.runPromise(Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => {
        sends.push(1)
        return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
      } })
      return yield* Stream.runCollect(model.streamText({ prompt: "inspect" }))
    }).pipe(Effect.provideService(CurrentModelCallRecorder, { record: data => Effect.sync(() => writes.push(data)).pipe(Effect.andThen(Effect.die(expected))) }), Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause)
      expect(isTurnError(failure)).toBe(true)
      expect(harnessCodeOf(failure)).toEqual(Option.some("turn.defect"))
      expect(isHarnessError(failure) ? failure.cause : undefined).toBe(expected)
    }
    expect(sends).toEqual([1])
    expect(writes).toHaveLength(1)
    expect(writes[0]?.outcome).toEqual({ _tag: "Completed" })
  })
})
