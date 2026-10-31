import { describe, expect, test } from "bun:test"
import { Effect, Match, Option, Redacted, Schema, Stream } from "effect"
import { AiError } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { CurrentModelCallPolicy, ENGINE_KEY, modelFailureOf, modelOverflowEvidenceOf, parseModelSelection } from "@xandreed/core"
import type { ModelCallPolicy, ModelLimits } from "@xandreed/core"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import type { ModelEndpoints } from "../ports/model-endpoints.port.js"
import { CurrentModelSettings } from "../ports/model-settings.port.js"
import type { ModelSettingsMap } from "./model-settings.entity.js"
import { buildProvider } from "./providers.js"

type Mode = "text" | "object" | "stream"
const refusal = { type: "invalid_request_error", message: "prompt is too long" }
const message = {
  id: "msg_overflow", type: "message", role: "assistant", model: "deployment",
  content: [{ type: "text", text: "Rejected response." }], stop_reason: "model_context_window_exceeded", stop_sequence: null,
  usage: { input_tokens: 40, output_tokens: 3 },
}
const failedCall = (options: {
  readonly selection: string
  readonly mode: Mode
  readonly settings?: ModelSettingsMap
  readonly policy?: ModelCallPolicy
  readonly endpoint?: boolean
  readonly raw?: boolean
  readonly compat?: boolean
  readonly error?: typeof refusal
}) => {
  const sent: Array<Record<string, unknown>> = []
  const endpoints: ModelEndpoints = options.endpoint === false ? {} : {
    [options.selection.split(":")[0]!]: { url: "https://fixture.invalid/v1", apiKey: "", ...(options.compat ? {} : { api: "anthropic-messages" as const }) },
  }
  const fetch = ((_: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)))
    const error = options.error ?? refusal
    if (options.mode === "stream") {
      const event = options.compat ? { error: { ...error, code: "context_length_exceeded" } } : { type: "error", error, request_id: "req_overflow" }
      return Promise.resolve(new Response(`${options.compat ? "" : "event: error\n"}data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } }))
    }
    return Promise.resolve(options.raw ? Response.json(message) : Response.json({ type: "error", error }, { status: 400 }))
  }) as typeof globalThis.fetch
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const selection = yield* Effect.fromOption(parseModelSelection(options.selection))
    const built = yield* buildProvider(selection, undefined, Redacted.make("fixture-key"))
    const call = Match.value(options.mode).pipe(
      Match.when("stream", () => Stream.runDrain(built.svc.streamText({ prompt: "Inspect the refusal." }))),
      Match.when("object", () => built.svc.generateObject({ prompt: "Inspect the refusal.", schema: Schema.Struct({ ok: Schema.Boolean }) }).pipe(Effect.asVoid)),
      Match.when("text", () => built.svc.generateText({ prompt: "Inspect the refusal." }).pipe(Effect.asVoid)),
      Match.exhaustive,
    )
    const failed = yield* Effect.flip(call)
    return { failed, selection, sent }
  })).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provideService(CurrentModelEndpoints, endpoints),
    Effect.provideService(CurrentModelSettings, options.settings ?? {}),
    Effect.provideService(CurrentModelCallPolicy, Option.fromNullishOr(options.policy)),
  ))
}

const engineOf = (error: AiError.AiError) => "metadata" in error.reason ? error.reason.metadata[ENGINE_KEY] : undefined

describe("overflow evidence belongs to the actual provider invocation", () => {
  test.each(["text", "object", "stream"] as const)("Messages %s carries alias limits and the effective sent output cap", async (mode) => {
    const { failed, selection, sent } = await failedCall({
      selection: "gateway:deployment", mode,
      settings: { "gateway:deployment": { limits: { contextWindow: 4096, maxOutputTokens: 128 } } },
      policy: { effort: "low", maxOutputTokens: 64 },
    })
    expect(modelFailureOf(failed)).toEqual(Option.some("ContextOverflow"))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.max_tokens).toBe(64)
    expect(engineOf(failed)).toMatchObject({ failure: "ContextOverflow", overflow: { model: { ...selection }, limits: { contextWindow: 4096, maxOutputTokens: 64 } } })
    expect(modelOverflowEvidenceOf(failed)).toEqual(Option.some({ model: selection, limits: { contextWindow: 4096, maxOutputTokens: 64 } }))
    expect(JSON.stringify(engineOf(failed))).not.toContain("fixture-key")
  })

  test.each(["text", "object"] as const)("raw HTTP 200 %s retains overflow identity before SDK response acceptance", async (mode) => {
    const { failed, selection, sent } = await failedCall({ selection: "gateway:deployment", mode, raw: true, settings: { "gateway:deployment": { limits: { maxOutputTokens: 128 } } } })
    expect(modelFailureOf(failed)).toEqual(Option.some("ContextOverflow"))
    expect(sent).toHaveLength(1)
    expect(engineOf(failed)).toMatchObject({ failure: "ContextOverflow", overflow: { model: { ...selection }, limits: { maxOutputTokens: 128 } } })
  })

  test("a documented profile supplies context capacity while a call override remains the sent output cap", async () => {
    const { failed, selection, sent } = await failedCall({ selection: "anthropic:claude-sonnet-5-5", mode: "text", endpoint: false, policy: { effort: "low", maxOutputTokens: 64 } })
    const limits: ModelLimits = { contextWindow: 1_000_000, maxOutputTokens: 64 }
    expect(modelFailureOf(failed)).toEqual(Option.some("ContextOverflow"))
    expect(sent[0]?.max_tokens).toBe(64)
    expect(engineOf(failed)).toMatchObject({ overflow: { model: { ...selection }, limits } })
  })

  test.each(["text", "object", "stream"] as const)("a compat %s route carries its identity without inventing limits", async (mode) => {
    const { failed, selection, sent } = await failedCall({ selection: "custom:deployment", mode, compat: true })
    expect(modelFailureOf(failed)).toEqual(Option.some("ContextOverflow"))
    expect(sent).toHaveLength(1)
    expect(engineOf(failed)).toMatchObject({ failure: "ContextOverflow", overflow: { model: { ...selection }, limits: {} } })
  })

  test("ordinary invalid settings retain their failure kind without overflow evidence", async () => {
    const { failed } = await failedCall({ selection: "gateway:deployment", mode: "text", settings: { "gateway:deployment": { limits: { maxOutputTokens: 128 } } }, error: { type: "invalid_request_error", message: "Invalid tool schema." } })
    expect(modelFailureOf(failed)).toEqual(Option.some("InvalidRequest"))
    expect(engineOf(failed)).toEqual({ failure: "InvalidRequest" })
  })
})
