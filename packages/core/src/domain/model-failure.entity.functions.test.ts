import { describe, expect, test } from "bun:test"
import { DateTime, Duration, Option, Schema } from "effect"
import { AiError, Response } from "effect/ai"
import { stampResponseModel } from "./engine-stamp.entity.functions.js"
import { ENGINE_KEY } from "./engine-stamp.entity.js"
import { modelFailureCodeOf, modelFailureOf, stampAiErrorFailure, stampPartFailure, stampResponseFailure } from "./model-failure.entity.functions.js"
import { ModelFailureKind, ModelFailureStamp } from "./model-failure.entity.js"
import { toPromptMessages, withUsageOnAssistant } from "../internal/mapping.entity.functions.js"
import { tokenUsage } from "./token-usage.entity.functions.js"

const http: typeof AiError.HttpContext.Type = {
  request: { method: "POST", url: "https://example.test/messages", urlParams: [], headers: {} },
  response: { status: 400, headers: { "request-id": "request-fixture" } }, body: "original response bytes",
}
const engine = { model: "fixture:model", requestVolatile: true, other: "keep" }
const custom = { signature: "α\nsigned==", requestId: "request-fixture" }
const metadata: AiError.ProviderMetadata = { [ENGINE_KEY]: engine, custom }
const usage = { promptTokens: 12, completionTokens: 3, totalTokens: 15 }
const errorOf = (reason: AiError.AiErrorReason) => AiError.make({ module: "Fixture", method: "generateText", reason })

describe("neutral model failures", () => {
  test("publishes exactly the nine kinds and their stable framework codes", () => {
    expect(ModelFailureKind.literals.map((kind) => [kind, modelFailureCodeOf(kind)])).toEqual([
      ["ContextOverflow", "model.context-overflow"], ["Authentication", "model.auth"], ["InvalidRequest", "model.invalid-request"],
      ["RateLimit", "model.rate-limit"], ["Quota", "model.quota"], ["Transient", "model.unavailable"],
      ["InvalidResponse", "model.invalid-response"], ["Timeout", "model.timeout"], ["Unknown", "model.failed"],
    ])
    expect(Option.isSome(Schema.decodeUnknownOption(ModelFailureStamp)({ failure: "ContextOverflow" }))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(ModelFailureStamp)({ failure: "length" }))).toBe(true)
  })

  test("uses only valid own neutral stamps, never provider codes, prose or recursive causes", () => {
    const stamped = stampAiErrorFailure(errorOf(new AiError.InvalidRequestError({ description: "opaque" })), "ContextOverflow")
    const unknown = [undefined, null, {}, { engine: { failure: "ContextOverflow" } }, { metadata: { engine: { failure: "length" } } },
      { metadata: { engine: Object.create({ failure: "ContextOverflow" }) } }, { metadata: Object.create({ engine: { failure: "ContextOverflow" } }) },
      { cause: stamped }, { error: stamped }, { metadata: { vendor: { failure: "ContextOverflow", code: "context_length_exceeded" } } }, "context window exceeded"]
    expect(unknown.map(modelFailureOf)).toEqual(unknown.map(() => Option.none()))
    expect(modelFailureOf({ metadata: { engine: { failure: "ContextOverflow", model: "fixture:model" } } })).toEqual(Option.some("ContextOverflow"))
  })

  test("explicit stamps precede neutral and malformed fallback, including across content arrays", () => {
    const malformed = errorOf(new AiError.InvalidOutputError({ description: "bad arguments", usage }))
    const protocol = stampAiErrorFailure(malformed, "InvalidResponse")
    expect(modelFailureOf(malformed)).toEqual(Option.none())
    expect(modelFailureOf(protocol)).toEqual(Option.some("InvalidResponse"))
    const fallback = Response.makePart("error", { error: errorOf(new AiError.UnknownError({ description: "unknown" })) })
    const explicit = stampPartFailure(Response.makePart("finish", { reason: "length", usage: new Response.Usage({ inputTokens: {}, outputTokens: {} }) }), "ContextOverflow")
    expect(modelFailureOf([fallback, explicit])).toEqual(Option.some("ContextOverflow"))
    expect(modelFailureOf(Response.makePart("error", { error: protocol }))).toEqual(Option.some("InvalidResponse"))
    expect(modelFailureOf(Response.makePart("error", { error: { code: "context_length_exceeded" } }))).toEqual(Option.none())
  })

  const reasons: ReadonlyArray<readonly [AiError.AiErrorReason, ModelFailureKind | "None"]> = [
    [new AiError.AuthenticationError({ kind: "InvalidKey" }), "Authentication"],
    [new AiError.InvalidRequestError({}), "InvalidRequest"],
    [new AiError.ContentPolicyError({ description: "policy" }), "InvalidRequest"],
    [new AiError.RateLimitError({ retryAfter: Duration.seconds(3) }), "RateLimit"],
    [new AiError.QuotaExhaustedError({}), "Quota"],
    [new AiError.InternalProviderError({ description: "unavailable" }), "Transient"],
    [new AiError.InvalidResponseError({ description: "protocol" }), "InvalidResponse"],
    [new AiError.UnknownError({ description: "unknown" }), "Unknown"],
    [new AiError.NetworkError({ reason: "TransportError", request: http.request }), "Transient"],
    [new AiError.NetworkError({ reason: "EncodeError", request: http.request }), "InvalidRequest"],
    [new AiError.NetworkError({ reason: "InvalidUrlError", request: http.request }), "InvalidRequest"],
    [new AiError.UnsupportedSchemaError({ description: "schema" }), "InvalidRequest"],
    [new AiError.InvalidUserInputError({ description: "unsupported input" }), "InvalidRequest"],
    [new AiError.InvalidOutputError({ description: "arguments" }), "None"],
    [new AiError.StructuredOutputError({ description: "output", responseText: "{}" }), "None"],
    [new AiError.ToolNotFoundError({ toolName: "missing", availableTools: [] }), "None"],
    [new AiError.ToolParameterValidationError({ toolName: "tool", description: "arguments" }), "None"],
    [new AiError.InvalidToolResultError({ toolName: "tool", description: "result" }), "None"],
    [new AiError.ToolResultEncodingError({ toolName: "tool", description: "encoding", toolResult: {} }), "None"],
    [new AiError.ToolConfigurationError({ toolName: "tool", description: "configuration" }), "None"],
    [new AiError.ToolkitRequiredError({ pendingApprovals: [] }), "None"],
  ]
  reasons.map(([reason, kind]) => test(`neutral ${reason._tag}${reason._tag === "NetworkError" ? `/${reason.reason}` : ""} fallback is ${kind}`, () => {
    expect(modelFailureOf(errorOf(reason))).toEqual(kind === "None" ? Option.none() : Option.some(kind))
    expect(modelFailureOf(reason)).toEqual(kind === "None" ? Option.none() : Option.some(kind))
  }))

  const stampable: ReadonlyArray<Extract<AiError.AiErrorReason, { readonly metadata: AiError.ProviderMetadata }>> = [
    new AiError.RateLimitError({ metadata, retryAfter: Duration.seconds(3), http }),
    new AiError.QuotaExhaustedError({ metadata, resetAt: DateTime.makeUnsafe(0), http }),
    new AiError.AuthenticationError({ metadata, kind: "ExpiredKey", description: "expired", http }),
    new AiError.ContentPolicyError({ metadata, description: "policy", http }),
    new AiError.InvalidRequestError({ metadata, parameter: "input", constraint: "bounded", description: "rejected", http }),
    new AiError.InvalidResponseError({ metadata, description: "protocol", http }),
    new AiError.InternalProviderError({ metadata, description: "unavailable", http }),
    new AiError.InvalidOutputError({ metadata, description: "decode", usage }),
    new AiError.StructuredOutputError({ metadata, description: "structured", responseText: "exact response", usage }),
    new AiError.UnsupportedSchemaError({ metadata, description: "schema" }),
    new AiError.UnknownError({ metadata, description: "unknown", http }),
  ]
  stampable.map((reason) => test(`stamping ${reason._tag} preserves its class, getters and declared evidence`, () => {
    const source = errorOf(reason)
    const before = JSON.stringify(source)
    const stamped = stampAiErrorFailure(source, "ContextOverflow")
    expect(AiError.isAiError(stamped)).toBe(true)
    expect(Object.getPrototypeOf(stamped)).toBe(Object.getPrototypeOf(source))
    expect(Object.getPrototypeOf(stamped.reason)).toBe(Object.getPrototypeOf(reason))
    expect(stamped.cause).toBe(stamped.reason)
    expect([stamped.message, stamped.isRetryable, stamped.retryAfter]).toEqual([source.message, source.isRetryable, source.retryAfter])
    expect(Object.entries(stamped.reason).filter(([key]) => key !== "metadata")).toEqual(Object.entries(reason).filter(([key]) => key !== "metadata"))
    expect("metadata" in stamped.reason ? stamped.reason.metadata : undefined).toEqual({ ...metadata, [ENGINE_KEY]: { ...engine, failure: "ContextOverflow" } })
    expect(modelFailureOf(stamped)).toEqual(Option.some("ContextOverflow"))
    expect(JSON.stringify(source)).toBe(before)
  }))

  test("metadata-less reasons retain identity and do not acquire invented stamps", () => {
    const network = errorOf(new AiError.NetworkError({ reason: "TransportError", request: http.request }))
    const tool = errorOf(new AiError.ToolParameterValidationError({ toolName: "tool", description: "arguments" }))
    expect(stampAiErrorFailure(network, "Timeout")).toBe(network)
    expect(stampAiErrorFailure(tool, "InvalidResponse")).toBe(tool)
    expect("metadata" in network.reason).toBe(false)
    expect(modelFailureOf(stampAiErrorFailure(network, "Timeout"))).toEqual(Option.some("Transient"))
  })

  test("model, failure and usage stamps coexist in either order without touching signature bytes or leaking to prompts", () => {
    const source = [Response.makePart("finish", { reason: "length", usage: new Response.Usage({ inputTokens: {}, outputTokens: {} }), metadata })]
    const before = JSON.stringify(source)
    const left = stampResponseModel(stampResponseFailure(source, "ContextOverflow"), "fixture:resolved")
    const right = stampResponseFailure(stampResponseModel(source, "fixture:resolved"), "ContextOverflow")
    expect(left).toEqual(right)
    expect(left[0]?.metadata[ENGINE_KEY]).toEqual({ model: "fixture:resolved", requestVolatile: true, other: "keep", failure: "ContextOverflow" })
    expect(left[0]?.metadata["custom"]).toEqual(metadata["custom"])
    expect(JSON.stringify(source)).toBe(before)
    const messages = withUsageOnAssistant([{ role: "assistant", content: [{ type: "text", text: "answer" }], providerOptions: left[0]?.metadata ?? {} }], tokenUsage({ inputTokens: 4, outputTokens: 2 }))
    expect(messages[0]?.providerOptions?.[ENGINE_KEY]).toMatchObject({ model: "fixture:resolved", failure: "ContextOverflow", inputTokens: 4, outputTokens: 2 })
    expect(toPromptMessages(messages)[0]?.options).toEqual({ [ENGINE_KEY]: { requestVolatile: true }, custom })
  })
})
