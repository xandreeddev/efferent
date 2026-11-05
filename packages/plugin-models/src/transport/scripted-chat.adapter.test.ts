import { describe, expect, test } from "bun:test"
import { Tool, Toolkit } from "effect/ai"
import { Deferred, Effect, Fiber, Option, Schema, Stream } from "effect"
import { ToolCallId } from "@xandreed/core"
import { makeCompatLanguageModel } from "../llm/compat.js"
import { CurrentModelRetryPolicy } from "../ports/model-retry-policy.port.js"
import { modelRetryDefaults } from "../llm/model-retry-policy.entity.js"
import { scriptedChatCompletions } from "./scripted-chat.adapter.js"
import { ScriptedReply } from "./scripted-chat.entity.js"
import type { ScriptedStep } from "./scripted-chat.entity.js"
import { fragmentsOf } from "./scripted-chat.entity.functions.js"

const chatUrl = "https://scripted.invalid/v1/chat/completions"
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json", authorization: "Bearer k" }, body: JSON.stringify(body) })

/** A response body's reads, one string per chunk the stream handed over. */
const reads = async (response: Response): Promise<ReadonlyArray<string>> => {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const step = async (seen: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
    const next = await reader.read()
    return next.done ? seen : step([...seen, decoder.decode(next.value)])
  }
  return step([])
}

const payloads = (events: ReadonlyArray<string>) => events.map((event) => event.replace(/^data: /, "").trimEnd())
const chunks = (events: ReadonlyArray<string>) => payloads(events).filter((payload) => payload !== "[DONE]").map((payload) => JSON.parse(payload) as Schema.JsonObject)

/** A compat client over a scripted endpoint, one attempt per call. */
const compat = (script: ReadonlyArray<ScriptedStep>) => {
  const scripted = scriptedChatCompletions(script)
  const model = makeCompatLanguageModel({ moduleName: "Scripted", chatUrl, apiKey: "k", model: "scripted-model", fetchImpl: scripted.fetch })
  return { scripted, model }
}
const once = Effect.provideService(CurrentModelRetryPolicy, { ...modelRetryDefaults, maxAttempts: 1 })
const Lookup = Tool.make("lookup", { parameters: Schema.Struct({ query: Schema.String }), success: Schema.String, failureMode: "error" })
const lookups = Toolkit.make(Lookup)

describe("scriptedChatCompletions: the wire it sends", () => {
  test("a streamed reply is one SSE event per read: the role, text and argument fragments, each call named first, the finish, the usage last, then [DONE]", async () => {
    const scripted = scriptedChatCompletions([{
      text: "Hello, world",
      toolCalls: [{ id: ToolCallId.make("call_a"), name: "lookup", arguments: `{"query":"alpha"}` }, { name: "lookup", arguments: ["{", `"query":"beta"}`] }],
      usage: { promptTokens: 12, completionTokens: 7, cachedTokens: 4, reasoningTokens: 2 },
      chunkSize: 5,
    }])
    const events = await reads(await scripted.fetch(chatUrl, post({ model: "m", stream: true, messages: [] })))
    expect(events.every((event) => event.startsWith("data: ") && event.endsWith("\n\n"))).toBe(true)
    expect(payloads(events).at(-1)).toBe("[DONE]")
    const sent = chunks(events)
    expect(sent.map((chunk) => chunk["choices"])).toEqual([
      [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
      [{ index: 0, delta: { content: ", wor" }, finish_reason: null }],
      [{ index: 0, delta: { content: "ld" }, finish_reason: null }],
      [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: "" } }] }, finish_reason: null }],
      [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: `{"que` } }] }, finish_reason: null }],
      [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: `ry":"` } }] }, finish_reason: null }],
      [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: `alpha` } }] }, finish_reason: null }],
      [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: `"}` } }] }, finish_reason: null }],
      [{ index: 0, delta: { tool_calls: [{ index: 1, type: "function", function: { name: "lookup", arguments: "" } }] }, finish_reason: null }],
      [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: "{" } }] }, finish_reason: null }],
      [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: `"query":"beta"}` } }] }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      [],
    ])
    expect(sent.at(-1)).toMatchObject({
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } },
    })
    expect(sent.slice(0, -1).some((chunk) => "usage" in chunk)).toBe(false)
    expect(sent.every((chunk) => chunk["object"] === "chat.completion.chunk" && chunk["model"] === "m" && chunk["id"] === "scripted-0")).toBe(true)
  })

  test("a reply without usage reports none, and reasoning streams before the text", async () => {
    const scripted = scriptedChatCompletions([{ reasoning: "think", text: "ok" }])
    const sent = chunks(await reads(await scripted.fetch(chatUrl, post({ model: "m", stream: true }))))
    expect(sent.map((chunk) => chunk["choices"])).toEqual([
      [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }],
      [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: "stop" }],
    ])
  })

  test("a settled request gets the whole reply in one body", async () => {
    const scripted = scriptedChatCompletions([{
      reasoning: ["thi", "nk"], text: ["Hel", "lo"],
      toolCalls: [{ name: "lookup", arguments: ["{}"] }],
      finishReason: "length",
      usage: { promptTokens: 3, completionTokens: 2 },
    }])
    const response = await scripted.fetch(chatUrl, post({ model: "m", messages: [] }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      id: "scripted-0", object: "chat.completion", created: 0, model: "m",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hello", reasoning_content: "think", tool_calls: [{ type: "function", function: { name: "lookup", arguments: "{}" } }] },
        finish_reason: "length",
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })
  })

  test("a string splits at its chunk size by characters, never inside one", () => {
    expect(fragmentsOf("abcdefg", 3)).toEqual(["abc", "def", "g"])
    expect(fragmentsOf("a😀b😀", 2)).toEqual(["a😀", "b😀"])
    expect(fragmentsOf("", 3)).toEqual([])
    expect(fragmentsOf(["", "x"], 3)).toEqual(["", "x"])
  })

  test("a script kept as JSON decodes with ScriptedReply", async () => {
    const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(ScriptedReply)))(
      JSON.stringify([{ toolCalls: [{ id: "c1", name: "lookup", arguments: "{}" }] }, { text: "done", usage: { promptTokens: 1, completionTokens: 1 } }]),
    ))
    expect(decoded[0]?.toolCalls?.[0]?.id).toBe(ToolCallId.make("c1"))
    const refused = await Effect.runPromise(Effect.flip(Schema.decodeUnknownEffect(ScriptedReply)({ text: "x", chunkSize: 0 })))
    expect(refused.message).toContain("chunkSize")
  })
})

describe("scriptedChatCompletions: matching requests to steps", () => {
  test("requests take the steps in order; a when picks its request; a repeat step keeps answering; every request is recorded", async () => {
    const scripted = scriptedChatCompletions([
      { text: "first" },
      { text: "for the summary", when: (request) => request.body["model"] === "summary" },
      { text: "standing", repeat: true },
    ])
    const textOf = async (model: string) => {
      const body = await (await scripted.fetch(chatUrl, post({ model }))).json() as { choices: ReadonlyArray<{ message: { content: string } }> }
      return body.choices[0]?.message.content
    }
    expect(await textOf("main")).toBe("first")
    expect(await textOf("summary")).toBe("for the summary")
    expect(await textOf("main")).toBe("standing")
    expect(await textOf("summary")).toBe("standing")
    const seen = await Effect.runPromise(scripted.requests)
    expect(seen.map((request) => [request.index, request.body["model"], request.step])).toEqual([
      [0, "main", Option.some(0)], [1, "summary", Option.some(1)], [2, "main", Option.some(2)], [3, "summary", Option.some(2)],
    ])
    expect(seen[0]).toMatchObject({ url: chatUrl, stream: false, headers: { authorization: "Bearer k", "content-type": "application/json" } })
    expect(await Effect.runPromise(scripted.remaining)).toEqual([2])
  })

  test("a request no step answers is refused with HTTP 400 naming it and the steps left, and the compat client fails at once without retrying", async () => {
    const { scripted, model } = compat([{ text: "only once" }, { text: "later", when: (request) => request.body["model"] === "other" }])
    const outcome = await Effect.runPromise(Effect.gen(function* () {
      const client = yield* model
      const first = yield* client.generateText({ prompt: "hi" })
      const second = yield* Effect.flip(client.generateText({ prompt: "hi" }))
      return { first: first.text, second }
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, modelRetryDefaults)))
    expect(outcome.first).toBe("only once")
    expect(outcome.second.reason._tag).toBe("InvalidRequestError")
    expect(outcome.second.message).toContain("scripted chat completions: request 1 (https://scripted.invalid/v1/chat/completions) was not answered: no step matched it (steps left: 1)")
    const seen = await Effect.runPromise(scripted.requests)
    expect(seen.map((request) => request.step)).toEqual([Option.some(0), Option.none()])
  })

  test("a body that is not a JSON object, or a when that throws, is refused and says why", async () => {
    const scripted = scriptedChatCompletions([{ text: "x", when: () => JSON.parse("{ the predicate broke") === null }])
    const notJson = await scripted.fetch(chatUrl, { method: "POST", body: "not json" })
    expect(notJson.status).toBe(400)
    expect(await notJson.json()).toEqual({ error: {
      type: "invalid_request_error", code: "scripted_request_unmatched",
      message: "scripted chat completions: request 0 (https://scripted.invalid/v1/chat/completions) was not answered: its body is not a JSON object (steps left: 0)",
    } })
    const thrown = await scripted.fetch(chatUrl, post({ model: "m" }))
    expect(((await thrown.json()) as { error: { message: string } }).error.message).toContain("the when of step 0 failed: JSON Parse error")
    expect((await Effect.runPromise(scripted.requests)).map((request) => [request.body, request.step])).toEqual([[{}, Option.none()], [{ model: "m" }, Option.none()]])
  })
})

describe("scriptedChatCompletions: under the compat client", () => {
  test("streamText reads the text and each call's argument fragments as they were sent, the usage from the final chunk", async () => {
    const { model } = compat([{
      text: "Looking.",
      toolCalls: [{ id: ToolCallId.make("call_a"), name: "lookup", arguments: [`{"query":`, `"alpha"}`] }, { name: "lookup", arguments: `{"query":"beta"}` }],
      usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 4 },
      chunkSize: 6,
    }])
    const parts = await Effect.runPromise(Effect.gen(function* () {
      const client = yield* model
      const toolkit = yield* lookups.pipe(Effect.provide(lookups.toLayer({ lookup: ({ query }) => Effect.succeed(query) })))
      return yield* Stream.runCollect(client.streamText({ prompt: "look both up", toolkit, disableToolCallResolution: true }))
    }).pipe(once))
    const typed = parts as ReadonlyArray<{ readonly type: string; readonly id?: string; readonly delta?: string; readonly params?: unknown; readonly usage?: unknown }>
    expect(typed.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["Lookin", "g."])
    expect(typed.filter((part) => part.type === "tool-params-delta").map((part) => [part.id, part.delta])).toEqual([
      ["call_a", `{"query":`], ["call_a", `"alpha"}`],
      ["call-1", `{"quer`], ["call-1", `y":"be`], ["call-1", `ta"}`],
    ])
    expect(typed.filter((part) => part.type === "tool-call").map((part) => part.params)).toEqual([{ query: "alpha" }, { query: "beta" }])
    expect(typed.at(-1)).toMatchObject({
      type: "finish", reason: "tool-calls",
      usage: { inputTokens: { total: 10, uncached: 6, cacheRead: 4 }, outputTokens: { total: 5 } },
    })
  })

  test("beforeChunk holds the rest of a streamed reply: the first text arrives while the endpoint still holds the tail", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const firstText = yield* Deferred.make<void>()
      const { scripted, model } = compat([{ text: ["first", " second"], beforeChunk: (chunk) => chunk === 2 ? Deferred.await(release) : Effect.void }])
      const client = yield* model
      const reading = yield* Effect.forkChild(Stream.runCollect(client.streamText({ prompt: "hi" }).pipe(
        Stream.tap((part) => part.type === "text-delta" ? Deferred.succeed(firstText, undefined) : Effect.void),
      )))
      yield* Deferred.await(firstText)
      const heldOpen = reading.pollUnsafe() === undefined
      yield* Deferred.succeed(release, undefined)
      const parts = yield* Fiber.join(reading)
      return { heldOpen, text: parts.flatMap((part) => part.type === "text-delta" ? [part.delta] : []), requests: (yield* scripted.requests).length }
    }).pipe(once))
    expect(observed).toEqual({ heldOpen: true, text: ["first", " second"], requests: 1 })
  })

  test("an aborted request's fetch rejects with the signal's reason, and an abort mid-stream stops the body", async () => {
    const scripted = scriptedChatCompletions([{ text: ["a", "b"], beforeChunk: (chunk) => chunk === 2 ? Effect.never : Effect.void }])
    const before = new AbortController()
    before.abort(new Error("cancelled before sending"))
    await expect(scripted.fetch(chatUrl, { ...post({ stream: true }), signal: before.signal })).rejects.toThrow("cancelled before sending")
    const during = new AbortController()
    const response = await scripted.fetch(chatUrl, { ...post({ stream: true }), signal: during.signal })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.read()
    during.abort(new Error("cancelled mid-stream"))
    await expect(reader.read()).rejects.toThrow("cancelled mid-stream")
    expect((await Effect.runPromise(scripted.requests)).map((request) => request.step)).toEqual([Option.some(0)])
  })
})
