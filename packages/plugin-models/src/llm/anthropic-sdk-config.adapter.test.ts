import { describe, expect, test } from "bun:test"
import { Context, Effect, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { CurrentModelCallPolicy, modelRequestDescriptorOf, parseModelSelection } from "@xandreed/core"
import type { ModelCallPolicy } from "@xandreed/core"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import { CurrentModelSettings } from "../ports/model-settings.port.js"
import type { ModelSettingsMap } from "./model-settings.entity.js"
import { buildProvider } from "./providers.js"

const fixture = () => {
  const requests: Array<Record<string, unknown>> = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const body = await request.json() as Record<string, unknown>
    requests.push(body)
    const choice = body["tool_choice"] as { readonly type?: string; readonly name?: string } | undefined
    return Response.json({ id: "msg_config_fixture", type: "message", role: "assistant", model: body["model"],
      content: choice?.type === "tool"
        ? [{ type: "tool_use", id: "object_fixture", name: choice.name, input: { ok: true } }]
        : [{ type: "text", text: '{"ok":true}' }],
      stop_reason: choice?.type === "tool" ? "tool_use" : "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 } })
  } })
  return { requests, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const ask = (server: ReturnType<typeof fixture>, options: {
  readonly model: string
  readonly object?: boolean
  readonly ambient?: Schema.JsonObject
  readonly settings?: ModelSettingsMap
  readonly policy?: Option.Option<ModelCallPolicy>
}) => Effect.runPromise(Effect.result(Effect.scoped(Effect.gen(function* () {
  const selection = yield* Effect.fromOption(parseModelSelection(`gateway:${options.model}`))
  const built = yield* buildProvider(selection, undefined, undefined)
  const response = yield* (options.object
    ? built.svc.generateObject({ prompt: "Return the fixture object.", schema: Schema.Struct({ ok: Schema.Boolean }) })
    : built.svc.generateText({ prompt: "Return the fixture object." })).pipe(
    Effect.updateContext((current: Context.Context<never>) => Context.merge(current,
      Context.makeUnsafe(new Map([["@effect/ai-anthropic/AnthropicLanguageModel/Config", options.ambient ?? {}]])),
    )),
  )
  return { response, descriptor: yield* modelRequestDescriptorOf(built.svc) }
}))).pipe(
  Effect.provideService(CurrentModelEndpoints, { gateway: { api: "anthropic-messages", url: server.url, apiKey: "fixture-placeholder" } }),
  Effect.provideService(CurrentModelSettings, options.settings ?? {}),
  Effect.provideService(CurrentModelCallPolicy, options.policy ?? Option.some({ effort: "high", maxOutputTokens: 2048 })),
  Effect.provide(FetchHttpClient.layer),
))

const budget = (model: string): ModelSettingsMap => ({
  [`gateway:${model}`]: { thinking: { _tag: "Budget", budgetTokens: 1024 } },
})

describe("owned Messages controls over ambient SDK configuration", () => {
  test("omitted unknown thinking stays omitted and the descriptor matches the request", async () => {
    const server = fixture()
    const result = await ask(server, { model: "deployment-alias", ambient: { thinking: { type: "enabled", budget_tokens: 100 }, temperature: 0.25 } }).finally(server.stop)
    expect(result._tag).toBe("Success")
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).not.toHaveProperty("thinking")
    expect(server.requests[0]?.["temperature"]).toBe(0.25)
    expect(result._tag === "Success" ? Option.map(result.success.descriptor, (value) => value.settings) : Option.none()).toEqual(Option.some({
      model: "deployment-alias", max_tokens: 2048, output_config: { effort: "high" }, systemPrelude: null,
      endpoint: { api: "anthropic-messages", url: server.url, auth: "x-api-key", apiVersion: "2023-06-01", betas: [] },
    }))
  })

  test("unsupported legacy effort stays omitted instead of being restored by ambient configuration", async () => {
    const server = fixture()
    const result = await ask(server, { model: "claude-haiku-4-5", ambient: { output_config: { effort: "high" } } }).finally(server.stop)
    expect(result._tag).toBe("Success")
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).not.toHaveProperty("output_config")
  })
})

describe("the pinned Anthropic SDK's structured-output tool fallback", () => {
  Array.of("claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5").map((model) => test(`${model} refuses a forced object fallback before I/O`, async () => {
    const server = fixture()
    const result = await ask(server, { model, object: true, ambient: { structuredOutputs: false } }).finally(server.stop)
    expect(result._tag === "Failure" ? result.failure._tag : "success").toBe("AiError")
    expect(result._tag === "Failure" ? String(result.failure) : "success").toContain("forced tool choice")
    expect(server.requests).toHaveLength(0)
  }))

  test("manual thinking refuses an explicitly selected tool fallback", async () => {
    const server = fixture()
    const model = "claude-opus-4-6"
    const result = await ask(server, { model, object: true, settings: budget(model), ambient: { structuredOutputs: false } }).finally(server.stop)
    expect(result._tag === "Failure" ? String(result.failure) : "success").toContain("forced tool choice")
    expect(server.requests).toHaveLength(0)
  })

  Array.of("claude-sonnet-4-0", "claude-sonnet-4-20250514", "claude-3-7-sonnet", "claude-opus-4-0", "claude-opus-4-20250514", "claude-3-5-haiku", "claude-3-unknown").map((id) => test(`configured aliases containing ${id} follow the SDK's legacy fallback`, async () => {
    const server = fixture()
    const model = `deployment/${id}/alias`
    const result = await ask(server, { model, object: true, settings: budget(model) }).finally(server.stop)
    expect(result._tag === "Failure" ? String(result.failure) : "success").toContain("forced tool choice")
    expect(server.requests).toHaveLength(0)
  }))

  Array.of("claude-opus-4-6", "deployment/claude-sonnet-4-5-claude-3-legacy", "deployment/claude-opus-4-1-claude-3-legacy").map((model) => test(`${model} keeps the SDK's native JSON path with a manual budget`, async () => {
    const server = fixture()
    const result = await ask(server, { model, object: true, settings: budget(model) }).finally(server.stop)
    expect(result._tag === "Failure" ? String(result.failure) : "Success").toBe("Success")
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).not.toHaveProperty("tool_choice")
    expect(server.requests[0]?.["output_config"]).toMatchObject({ format: { type: "json_schema" } })
    expect(server.requests[0]?.["thinking"]).toMatchObject({ type: "enabled", budget_tokens: 1024 })
  }))

  test("an explicit native JSON override remains valid with manual thinking on a legacy alias", async () => {
    const server = fixture()
    const model = "deployment/claude-3-7-sonnet/alias"
    const result = await ask(server, { model, object: true, settings: budget(model), ambient: { structuredOutputs: true } }).finally(server.stop)
    expect(result._tag === "Failure" ? String(result.failure) : "Success").toBe("Success")
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).not.toHaveProperty("tool_choice")
    expect(server.requests[0]?.["output_config"]).toMatchObject({ format: { type: "json_schema" } })
  })

  test("an ordinary text request does not use the object fallback", async () => {
    const server = fixture()
    const result = await ask(server, { model: "claude-fable-5-1", ambient: { structuredOutputs: false } }).finally(server.stop)
    expect(result._tag).toBe("Success")
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).not.toHaveProperty("tool_choice")
  })

  test("a permitted tool fallback still generates an object for an unknown alias", async () => {
    const server = fixture()
    const result = await ask(server, { model: "deployment-alias", object: true, ambient: { structuredOutputs: false } }).finally(server.stop)
    expect(result._tag === "Failure" ? String(result.failure) : "Success").toBe("Success")
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]?.["tool_choice"]).toMatchObject({ type: "tool" })
  })
})
