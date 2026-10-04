import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer, Option, Redacted, Ref, Result, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { HttpClient, HttpClientResponse } from "effect/http"
import { AuthStore, CurrentModelCallPolicy, EngineSettings, Failure, ModelId, ModelSelection, ProviderId, SettingsStore, UtilityLlm, foldStreamParts, modelRequestDescriptorOf, responseToAgentMessages, toPromptMessages } from "@xandreed/core"
import type { AgentMessage } from "@xandreed/core"
import { ModelTransport } from "../ports/model-transport.port.js"
import type { ModelFetch } from "../ports/model-transport.port.js"
import { LanguageModelLive, LanguageModelSelectionLive } from "./router.js"
import { UtilityLlmLive } from "./utilityLlm.js"
import { VERCEL_CHAT_URL } from "./providers.js"

const selected = new ModelSelection({ provider: ProviderId.make("vercel"), modelId: ModelId.make("deepseek/deepseek-v4.1-flash") })
const Read = Tool.make("read_file", { description: "Read a file.", parameters: Schema.Struct({ path: Schema.String, startLine: Schema.optionalKey(Schema.Int) }), success: Schema.Struct({ content: Schema.String }), failure: Failure, failureMode: "return" })
const auth = (key: Effect.Effect<Option.Option<Redacted.Redacted<string>>>) => Layer.succeed(AuthStore, AuthStore.of({ all: Effect.succeed(new Map()), get: () => Effect.succeed(Option.none()), resolveKey: () => key, set: () => Effect.void, remove: () => Effect.void }))
const transport = (impl: ModelFetch) => Layer.succeed(ModelTransport, { fetch: impl, codex: Option.none(), http: HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ error: "unexpected native request" }, { status: 400 })))) })
const reasonings = ["inspect requested file", "", "report recovered result"]
const details = (index: number) => index === 1
  ? [{ type: "reasoning.encrypted", index: 0, data: "fixture-opaque-continuation", format: "unknown" }]
  : [{ type: "reasoning.text", index: 0, text: reasonings[index], format: "unknown", signature: `fixture-proof-${index}` }]
const wire = (index: number) => ({ choices: [{ finish_reason: index < 2 ? "tool_calls" : "stop", message: { content: index < 2 ? null : "README recovered successfully.", reasoning: reasonings[index], reasoning_details: details(index), ...(index < 2 ? { tool_calls: [{ id: `read-${index}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: index === 0 ? "missing.md" : "README.md" }) } }] } : {}) } }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } })
const sse = (index: number) => {
  const message = wire(index).choices[0]!.message
  const chunks = [
    { choices: [{ delta: { reasoning: reasonings[index]!.slice(0, 8), reasoning_details: index === 1 ? [{ type: "reasoning.encrypted", index: 0, data: "fixture-opaque-", format: "unknown" }] : [{ type: "reasoning.text", index: 0, text: reasonings[index]!.slice(0, 8), format: "unknown" }] }, finish_reason: null }] },
    { choices: [{ delta: { reasoning: reasonings[index]!.slice(8), reasoning_details: index === 1 ? [{ type: "reasoning.encrypted", index: 0, data: "continuation" }] : [{ type: "reasoning.text", index: 0, text: reasonings[index]!.slice(8), signature: `fixture-proof-${index}` }] }, finish_reason: null }] },
    { choices: [{ delta: { content: message.content, ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls.map((call) => ({ ...call, index: 0 })) }) }, finish_reason: index < 2 ? "tool_calls" : "stop" }], usage: wire(index).usage },
  ]
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
}

;[false, true].forEach((streaming) => test(`Vercel ${streaming ? "streamed" : "settled"} shared provider retains native tools and normalized reasoning through recovery`, async () => {
  const requests: Array<Record<string, unknown>> = []
  const invoked: Array<string> = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const impl: ModelFetch = (url, init) => {
      expect(String(url)).toBe(VERCEL_CHAT_URL)
      const headers = new Headers(init?.headers)
      expect(headers.get("authorization")).toBe("Bearer fixture-saved-key")
      expect(headers.has("x-opencode-session")).toBe(false)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      const index = requests.length - 1
      const prior = (body["messages"] as ReadonlyArray<Record<string, unknown>>).filter((message) => message["role"] === "assistant")
      const validReplay = prior.every((message, at) => message["reasoning"] === reasonings[at] && JSON.stringify(message["reasoning_details"]) === JSON.stringify(details(at)))
      return Promise.resolve(validReplay ? streaming ? sse(index) : Response.json(wire(index)) : Response.json({ error: { type: "ModelError", message: "reasoning continuation missing" } }, { status: 400 }))
    }
    const model = yield* LanguageModel.LanguageModel.pipe(Effect.provide(LanguageModelSelectionLive(selected, Option.none()).pipe(Layer.provide(Layer.merge(auth(Effect.succeed(Option.some(Redacted.make("fixture-saved-key")))), transport(impl))))))
    const kit = Toolkit.make(Read)
    const handlers = kit.toLayer({ read_file: ({ path }) => Effect.sync(() => { invoked.push(path) }).pipe(Effect.andThen(path === "missing.md" ? Effect.fail({ error: "NotFound", message: "Use README.md to recover." }) : Effect.succeed({ content: "README fixture" }))) })
    return yield* Effect.reduce([0, 1, 2], () => ({ messages: [{ role: "user", content: "Read the missing file and recover using README.md." }] as ReadonlyArray<AgentMessage>, text: "" }), (state) => Effect.gen(function* () {
      const options = { prompt: Prompt.make(toPromptMessages(state.messages) as never), toolkit: kit }
      const response = streaming ? yield* foldStreamParts(model.streamText(options), () => Effect.void) : yield* model.generateText(options)
      const tail = responseToAgentMessages(response.content)
      return { messages: [...state.messages, ...tail], text: tail.flatMap((message) => message.role === "assistant" ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("") }
    }).pipe(Effect.provide(handlers)))
  }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})), Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "low", maxOutputTokens: 64 }))))
  expect(result.text).toBe("README recovered successfully.")
  expect(invoked).toEqual(["missing.md", "README.md"])
  expect(requests).toHaveLength(3)
  expect(requests.every((body) => body["model"] === selected.modelId && body["max_tokens"] === 64)).toBe(true)
  expect(requests.every((body) => JSON.stringify(body["reasoning"]) === JSON.stringify({ enabled: true, effort: "low" }))).toBe(true)
  expect(requests.every((body) => JSON.stringify(body["providerOptions"]) === JSON.stringify({ gateway: { order: ["deepseek"] } }))).toBe(true)
  expect(requests.every((body) => body["thinking"] === undefined && body["reasoning_effort"] === undefined && body["prompt_cache_key"] === undefined)).toBe(true)
  expect(requests[0]?.["tools"]).toMatchObject([{ function: { name: "read_file", parameters: { required: ["path"], additionalProperties: false } } }])
  expect((requests[1]?.["messages"] as ReadonlyArray<Record<string, unknown>>).find((message) => message["role"] === "tool")).toMatchObject({ tool_call_id: "read-0", content: JSON.stringify({ error: "NotFound", message: "Use README.md to recover." }) })
  expect(result.messages.filter((message) => message.role === "tool").flatMap((message) => message.content.map((part) => part.isError))).toEqual([true, false])
}))

test("Vercel reads fresh env/saved credentials per call and the shared helper keeps output policy", async () => {
  const requests: Array<{ authorization: string | null; body: Record<string, unknown> }> = []
  const output = await Effect.runPromise(Effect.gen(function* () {
    const key = yield* Ref.make("fixture-first-saved")
    const impl: ModelFetch = (_url, init) => {
      requests.push({ authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return Promise.resolve(Response.json({ choices: [{ finish_reason: "stop", message: { content: "Gateway response" } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }))
    }
    const settings = Layer.succeed(SettingsStore, SettingsStore.of({ load: Effect.succeed(new EngineSettings({ model: Option.some("vercel:deepseek/deepseek-v4.1-flash"), fastModel: Option.some("vercel:deepseek/deepseek-v4.1-flash") })), set: () => Effect.void, setRole: () => Effect.void }))
    const dependencies = Layer.mergeAll(auth(Ref.get(key).pipe(Effect.map((value) => Option.some(Redacted.make(value))))), transport(impl), settings)
    const services = yield* Layer.build(Layer.merge(LanguageModelLive, UtilityLlmLive).pipe(Layer.provide(dependencies)))
    const model = yield* LanguageModel.LanguageModel.pipe(Effect.provide(services))
    yield* model.generateText({ prompt: "Saved key." }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})))
    yield* Ref.set(key, "fixture-refreshed-saved")
    yield* model.generateText({ prompt: "Refreshed key." }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ AI_GATEWAY_API_KEY: "  " })))
    yield* model.generateText({ prompt: "Env key." }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ AI_GATEWAY_API_KEY: "fixture-env-key" })))
    const helper = yield* UtilityLlm.pipe(Effect.flatMap((utility) => utility.complete("Helper.")), Effect.provide(services), Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ AI_GATEWAY_API_KEY: "fixture-second-env-key" })))
    const descriptor = yield* modelRequestDescriptorOf(model)
    return { text: helper.text, descriptor }
  }).pipe(Effect.scoped, Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "none", maxOutputTokens: 80 }))))
  expect(requests.map((request) => request.authorization)).toEqual(["Bearer fixture-first-saved", "Bearer fixture-refreshed-saved", "Bearer fixture-env-key", "Bearer fixture-second-env-key"])
  expect(requests.every((request) => request.body["max_tokens"] === 80)).toBe(true)
  expect(requests.every((request) => JSON.stringify(request.body["reasoning"]) === JSON.stringify({ enabled: false, effort: "none" }))).toBe(true)
  expect(output.text).toBe("Gateway response")
  expect(JSON.stringify(output.descriptor)).not.toContain("fixture-env-key")
})

test("missing Vercel credentials fail before dispatch with the shared typed auth error", async () => {
  const requests: Array<string> = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const model = yield* LanguageModel.LanguageModel.pipe(Effect.provide(LanguageModelSelectionLive(selected, Option.none()).pipe(Layer.provide(Layer.merge(auth(Effect.succeed(Option.none())), transport((url) => { requests.push(String(url)); return Promise.resolve(Response.json({})) }))))))
    return yield* Effect.result(model.generateText({ prompt: "hello" }))
  }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))))
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure).toMatchObject({ _tag: "AuthError", provider: "vercel", message: expect.stringContaining("AI_GATEWAY_API_KEY") })
  expect(requests).toEqual([])
})
