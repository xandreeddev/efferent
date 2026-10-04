import { describe, expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Effect, Layer, Option, Redacted, Ref } from "effect"
import { AuthStore, CurrentPromptCacheKey, EngineSettings, ModelId, ModelSelection, ProviderId, SettingsStore } from "@xandreed/core"
import type { ModelFetch } from "../ports/model-transport.port.js"
import { ModelTransport } from "../ports/model-transport.port.js"
import { LanguageModelLive, LanguageModelSelectionLive } from "./router.js"
import { UtilityLlmLive } from "./utilityLlm.js"
import { UtilityLlm } from "@xandreed/core"

const auth = Layer.succeed(AuthStore, AuthStore.of({
  all: Effect.succeed(new Map()), get: () => Effect.succeed(Option.none()),
  resolveKey: () => Effect.succeed(Option.some(Redacted.make("fixture-key"))),
  set: () => Effect.void, remove: () => Effect.void,
}))
const selection = (provider: string, model: string) => new ModelSelection({ provider: ProviderId.make(provider), modelId: ModelId.make(model) })

describe("provider transport substitution", () => {
  test("OpenCode native Responses requests keep the conversation routing headers and bearer pipeline", async () => {
    const requests: Array<{ url: string; session: string | undefined; agent: string | undefined; authPresent: boolean }> = []
    const result = await Effect.runPromise(Effect.gen(function* () {
      const http = HttpClient.make((request) => Effect.sync(() => {
        requests.push({ url: request.url, session: request.headers["x-opencode-session"], agent: request.headers["user-agent"], authPresent: request.headers["authorization"]?.startsWith("Bearer ") === true })
        return HttpClientResponse.fromWeb(request, Response.json({
          id: "response-fixture", object: "response", created_at: 1, status: "completed", model: "gpt-fixture",
          output: [{ id: "message-fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "OpenCode routed", annotations: [] }] }],
          usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        }))
      }))
      const transport = Layer.succeed(ModelTransport, { http, fetch, codex: Option.none() })
      const model = yield* LanguageModel.LanguageModel.pipe(Effect.provide(LanguageModelSelectionLive(selection("opencode", "gpt-fixture"), Option.none()).pipe(Layer.provide(Layer.merge(auth, transport)))))
      return yield* model.generateText({ prompt: "Hello." })
    }).pipe(Effect.provideService(CurrentPromptCacheKey, Option.some("native-conversation"))))
    expect(result.text).toBe("OpenCode routed")
    expect(requests).toEqual([{ url: "https://opencode.ai/zen/v1/responses", session: "native-conversation", agent: "efferent/0.8.0-next.0", authPresent: true }])
  })
  test("the native Responses adapter keeps production decoding over an injected HttpClient", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<string>>([])
      const http = HttpClient.make((request) => Ref.update(requests, (values) => [...values, request.url]).pipe(Effect.as(HttpClientResponse.fromWeb(request, Response.json({
        id: "response-fixture", object: "response", created_at: 1, status: "completed", model: "gpt-fixture",
        output: [{ id: "message-fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "native transport", annotations: [] }] }],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      })))))
      const transport = Layer.succeed(ModelTransport, { http, fetch, codex: Option.none() })
      const model = yield* LanguageModel.LanguageModel.pipe(Effect.provide(LanguageModelSelectionLive(selection("openai", "gpt-fixture"), Option.none()).pipe(Layer.provide(Layer.merge(auth, transport)))))
      const response = yield* model.generateText({ prompt: "Inspect the transport." })
      return { text: response.text, urls: yield* Ref.get(requests) }
    }))
    expect(result.text).toBe("native transport")
    expect(result.urls).toEqual(["https://api.openai.com/v1/responses"])
  })

  test("routed and helper calls retain the compat adapter and use the injected fetch", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<string>>([])
      const impl: ModelFetch = (url) => Effect.runPromise(Ref.update(requests, (values) => [...values, String(url)]).pipe(Effect.as(Response.json({
        choices: [{ finish_reason: "stop", message: { content: "compat transport" } }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }))))
      const http = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ error: "unexpected native request" }, { status: 500 }))))
      const transport = Layer.succeed(ModelTransport, { http, fetch: impl, codex: Option.none() })
      const settings = Layer.succeed(SettingsStore, SettingsStore.of({ load: Effect.succeed(new EngineSettings({ model: Option.some("opencode:fixture-controller"), fastModel: Option.some("opencode:fixture-editor") })), set: () => Effect.void, setRole: () => Effect.void }))
      const dependencies = Layer.mergeAll(auth, transport, settings)
      const services = yield* Layer.build(Layer.merge(LanguageModelLive, UtilityLlmLive).pipe(Layer.provide(dependencies)))
      const response = yield* LanguageModel.generateText({ prompt: "Controller." }).pipe(Effect.provide(services))
      const helper = yield* UtilityLlm.pipe(Effect.flatMap((utility) => utility.complete("Editor.")), Effect.provide(services))
      return { text: response.text, helper: helper.text, urls: yield* Ref.get(requests) }
    }).pipe(Effect.scoped))
    expect(result.text).toBe("compat transport")
    expect(result.helper).toBe("compat transport")
    expect(result.urls).toHaveLength(2)
    expect(result.urls.every((url) => url === "https://opencode.ai/zen/go/v1/chat/completions")).toBe(true)
  })
})
