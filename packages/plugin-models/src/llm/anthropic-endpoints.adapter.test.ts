import { describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Effect, Option, Redacted, Result, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { CurrentModelCallPolicy, modelRequestDescriptorOf, parseModelSelection } from "@xandreed/core"
import type { ModelCallPolicy } from "@xandreed/core"
import { CurrentModelSettings } from "../ports/model-settings.port.js"
import type { ModelSettingsMap } from "./model-settings.entity.js"
import { THINKING_BINDING_BETA } from "./thinking-binding.entity.js"
import type { Credential } from "../ports/auth-store.port.js"
import { CurrentModelEndpoints, ModelEndpoint } from "../ports/model-endpoints.port.js"
import { anthropicBaseUrl, buildProvider } from "./providers.js"

const endpointResult = Schema.decodeUnknownResult(ModelEndpoint, { onExcessProperty: "error" })
const fixture = () => {
  const requests: Array<{ path: string; key: string | null; authorization: string | null; version: string | null; betas: string | null; body: Record<string, unknown> }> = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const body = await request.json() as Record<string, unknown>
    requests.push({ path: new URL(request.url).pathname, key: request.headers.get("x-api-key"), authorization: request.headers.get("authorization"),
      version: request.headers.get("anthropic-version"), betas: request.headers.get("anthropic-beta"), body })
    return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: body["model"], content: [{ type: "text", text: "Messages fixture reply." }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } })
  } })
  return { requests, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}
const ask = (endpoint: ModelEndpoint, key?: string, credential?: Credential, config?: ConfigProvider.ConfigProvider) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const selected = yield* Effect.fromOption(parseModelSelection("gateway:claude-opus-4-7"))
  const built = yield* buildProvider(selected, credential, key === undefined ? undefined : Redacted.make(key))
  const result = yield* Effect.result(built.svc.generateText({ prompt: "Inspect the gateway request." }))
  return { result, route: built.route, prepend: built.prependClaudeCode }
})).pipe(
  Effect.provideService(CurrentModelEndpoints, { gateway: endpoint }),
  Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "low", maxOutputTokens: 64 })),
  Effect.provide(FetchHttpClient.layer),
  config === undefined ? (effect) => effect : Effect.provideService(ConfigProvider.ConfigProvider, config),
))

describe("Anthropic Messages endpoint configuration", () => {
  test("preserves legacy endpoints and keeps protocol-specific options separate", () => {
    expect(Result.isSuccess(endpointResult({ url: "http://gateway.example/v1", standardOnly: false }))).toBe(true)
    expect(Result.isSuccess(endpointResult({ api: "chat-completions", url: "http://gateway.example/v1", images: true }))).toBe(true)
    expect(Result.isSuccess(endpointResult({ api: "anthropic-messages", url: "http://gateway.example", auth: "bearer", apiVersion: "2026-10-21", betas: ["fixture-2026-10-01"] }))).toBe(true)
    expect(Result.isFailure(endpointResult({ api: "anthropic-messages", url: "http://gateway.example", standardOnly: true }))).toBe(true)
    expect(Result.isFailure(endpointResult({ api: "chat-completions", url: "http://gateway.example/v1", auth: "bearer" }))).toBe(true)
    expect(Result.isFailure(endpointResult({ api: "unrecognized", url: "http://gateway.example" }))).toBe(true)
  })

  test("sends an opaque placeholder in x-api-key, explicit version and betas through Messages", async () => {
    const server = fixture()
    const observed = await ask({ api: "anthropic-messages", url: `${server.url}/proxy/v1/`, apiKey: "gateway-placeholder",
      apiVersion: "2026-10-21", betas: ["fixture-2026-10-01", "fixture-2026-10-01"] }).finally(server.stop)
    expect(server.requests[0]).toMatchObject({ path: "/proxy/v1/messages", key: "gateway-placeholder", authorization: null, version: "2026-10-21",
      betas: "fixture-2026-10-01", body: { model: "claude-opus-4-7", max_tokens: 64 } })
    expect(observed.route).toBe("anthropic")
    expect(observed.prepend).toBe(false)
    expect(observed.result._tag === "Success" ? observed.result.success.text : "failed").toBe("Messages fixture reply.")
  })

  test("bearer authentication preserves placeholder bytes and sends no x-api-key or subscription prelude", async () => {
    const server = fixture()
    const credential: Credential = { type: "oauth", access: Redacted.make("stored-subscription"), refresh: Redacted.make("unused"), expires: 9_999_999_999_999 }
    const observed = await ask({ api: "anthropic-messages", url: server.url, auth: "bearer", apiKey: "literal-placeholder" }, "stored-subscription", credential).finally(server.stop)
    expect(server.requests[0]).toMatchObject({ path: "/v1/messages", key: null, authorization: "Bearer literal-placeholder", version: "2023-06-01" })
    expect(JSON.stringify(server.requests[0]?.body)).not.toContain("Claude Code")
    expect(observed.prepend).toBe(false)
    expect(observed.result._tag).toBe("Success")
  })

  test("keeps own, environment and stored key precedence and explicit no-key configuration", async () => {
    const server = fixture()
    const config = ConfigProvider.fromEnvRecord({ MESSAGES_FIXTURE_KEY: "environment-placeholder" })
    await ask({ api: "anthropic-messages", url: server.url, apiKeyEnv: "MESSAGES_FIXTURE_KEY" }, "stored-placeholder", undefined, config)
    await ask({ api: "anthropic-messages", url: server.url }, "stored-placeholder")
    await ask({ api: "anthropic-messages", url: server.url, apiKey: "" }, "stored-placeholder").finally(server.stop)
    expect(server.requests.map((request) => request.key)).toEqual(["environment-placeholder", "stored-placeholder", null])
    expect(server.requests.every((request) => request.authorization === null)).toBe(true)
  })
})

const Probe = Tool.make("fixture_probe", { description: "A fixture tool.", parameters: Tool.EmptyParams, success: Schema.String })
const kit = Toolkit.make(Probe)
const controlled = (server: ReturnType<typeof fixture>, options: {
  readonly selection: string
  readonly settings?: ModelSettingsMap
  readonly policy?: Option.Option<ModelCallPolicy>
  readonly choice?: LanguageModel.ToolChoice<"fixture_probe">
  readonly prompt?: Prompt.RawInput
  readonly ambient?: Schema.JsonObject
  readonly betas?: ReadonlyArray<string>
}) => Effect.runPromise(Effect.result(Effect.scoped(Effect.gen(function* () {
  const selected = yield* Effect.fromOption(parseModelSelection(options.selection))
  const built = yield* buildProvider(selected, undefined, undefined)
  const tools = yield* kit.pipe(Effect.provide(kit.toLayer({ fixture_probe: () => Effect.succeed("unused") })))
  const response = yield* built.svc.generateText({ prompt: options.prompt ?? "Inspect the configured controls.", toolkit: tools,
    ...(options.choice === undefined ? {} : { toolChoice: options.choice }),
  }).pipe(Effect.updateContext((current: Context.Context<never>) => Context.merge(current,
    Context.makeUnsafe(new Map([["@effect/ai-anthropic/AnthropicLanguageModel/Config", options.ambient ?? {}]])),
  )))
  return { response, descriptor: yield* modelRequestDescriptorOf(built.svc) }
}))).pipe(
  Effect.provideService(CurrentModelEndpoints, { gateway: { api: "anthropic-messages", url: `${server.url}/v1`, apiKey: "fixture-placeholder", ...(options.betas === undefined ? {} : { betas: options.betas }) } }),
  Effect.provideService(CurrentModelSettings, options.settings ?? {}),
  Effect.provideService(CurrentModelCallPolicy, options.policy ?? Option.none()),
  Effect.provide(FetchHttpClient.layer),
))

describe("Messages settings on the wire", () => {
  test("joins root, versioned and proxy-prefix base URLs exactly once", () => {
    expect(["https://gw.example", "https://gw.example/", "https://gw.example/v1", "https://gw.example/v1//"].map(anthropicBaseUrl)).toEqual(Array(4).fill("https://gw.example"))
    expect(anthropicBaseUrl("https://gw.example/proxy/v1/")).toBe("https://gw.example/proxy")
    expect(anthropicBaseUrl("https://gw.example/proxy/")).toBe("https://gw.example/proxy")
  })

  test("uses profile defaults, summarized thinking and the planned default binding without replacing SDK betas", async () => {
    const server = fixture()
    const result = await controlled(server, { selection: "gateway:claude-opus-5-5", betas: ["fixture-2026-10-01", THINKING_BINDING_BETA] }).finally(server.stop)
    expect(result._tag === "Failure" ? String(result.failure) : "Success").toBe("Success")
    expect(server.requests[0]?.body).toMatchObject({ max_tokens: 128_000, output_config: { effort: "medium" }, thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } } })
    const flags = server.requests[0]?.betas?.split(",") ?? []
    expect(flags).toEqual(["structured-outputs-2025-11-13", "fixture-2026-10-01", THINKING_BINDING_BETA])
    expect(flags.filter((flag) => flag === THINKING_BINDING_BETA)).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain("fixture-placeholder")
  })

  test("resolves policy before settings before profile and keeps owned fields ahead of later SDK configuration", async () => {
    const server = fixture()
    const configured = { "gateway:claude-fable-5-1": { effort: "xhigh" as const, limits: { maxOutputTokens: 512 } } }
    await controlled(server, { selection: "gateway:claude-fable-5-1", settings: configured })
    await controlled(server, { selection: "gateway:claude-fable-5-1", settings: configured, policy: Option.some({ effort: "max", maxOutputTokens: 128 }),
      ambient: { model: "different-model", max_tokens: 900, thinking: { type: "disabled" }, output_config: { effort: "low" } },
    }).finally(server.stop)
    expect(server.requests.map(({ body }) => [body["model"], body["max_tokens"], body["output_config"]])).toEqual([
      ["claude-fable-5-1", 512, { effort: "xhigh" }], ["claude-fable-5-1", 128, { effort: "max" }],
    ])
    expect(server.requests[1]?.body["thinking"]).toMatchObject({ type: "adaptive", display: "summarized" })
  })

  test("honors legal Off and BetweenTools modes without adding display, budgets or binding fields", async () => {
    const server = fixture()
    await controlled(server, { selection: "gateway:claude-haiku-5-5", settings: { "gateway:claude-haiku-5-5": { thinking: { _tag: "Off" }, effort: "high" } } })
    await controlled(server, { selection: "gateway:claude-sonnet-5-5", settings: { "gateway:claude-sonnet-5-5": { thinking: { _tag: "BetweenTools" }, effort: "high" } } }).finally(server.stop)
    expect(server.requests.map(({ body }) => body["thinking"])).toEqual([{ type: "disabled" }, { type: "between_tools" }])
    expect(server.requests.every(({ betas }) => !betas?.split(",").includes(THINKING_BINDING_BETA))).toBe(true)
  })

  test("rejects invalid model settings and forced-tool combinations before network I/O", async () => {
    const server = fixture()
    const off = await controlled(server, { selection: "gateway:claude-opus-5-5", settings: { "gateway:claude-opus-5-5": { thinking: { _tag: "Off" } } } })
    const forced = await controlled(server, { selection: "gateway:claude-fable-5-1", choice: "required" }).finally(server.stop)
    expect(off._tag === "Failure" ? off.failure._tag : "success").toBe("ModelSettingsError")
    expect(forced._tag === "Failure" ? forced.failure._tag : "success").toBe("AiError")
    expect(server.requests).toHaveLength(0)
  })

  test("allows documented forced-tool support on adaptive Haiku and legacy manual budgets only with auto choice", async () => {
    const server = fixture()
    const haiku = await controlled(server, { selection: "gateway:claude-haiku-5-5", choice: "required" })
    const budget = await controlled(server, { selection: "gateway:claude-opus-4-6", settings: { "gateway:claude-opus-4-6": { thinking: { _tag: "Budget", budgetTokens: 1024 }, limits: { maxOutputTokens: 2048 } } } }).finally(server.stop)
    expect([haiku, budget].map((result) => result._tag === "Failure" ? String(result.failure) : "Success")).toEqual(["Success", "Success"])
    expect(server.requests[0]?.body["tool_choice"]).toEqual({ type: "any" })
    expect(server.requests[1]?.body["thinking"]).toEqual({ type: "enabled", budget_tokens: 1024, display: "summarized" })
  })

  test("preserves replayed signed and redacted blocks through a configured Messages gateway", async () => {
    const server = fixture()
    const prompt = Prompt.make([
      { role: "user", content: "Do the work." },
      { role: "assistant", content: [
        { type: "reasoning", text: "Earlier reasoning.", options: { anthropic: { info: { type: "thinking", signature: "signature/+=opaque" } } } },
        { type: "reasoning", text: "", options: { anthropic: { info: { type: "redacted_thinking", redactedData: "redacted/+=opaque" } } } },
        { type: "tool-call", id: "old-call", name: "fixture_probe", params: {}, providerExecuted: false },
      ] },
      { role: "tool", content: [{ type: "tool-result", id: "old-call", name: "fixture_probe", isFailure: false, result: "done" }] },
    ] as Prompt.RawInput)
    const result = await controlled(server, { selection: "gateway:claude-opus-5-5", prompt }).finally(server.stop)
    expect(result._tag === "Failure" ? String(result.failure) : "Success").toBe("Success")
    const messages = server.requests[0]?.body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(messages[1]?.content.slice(0, 2)).toEqual([
      { type: "thinking", thinking: "Earlier reasoning.", signature: "signature/+=opaque" }, { type: "redacted_thinking", data: "redacted/+=opaque" },
    ])
  })
})
