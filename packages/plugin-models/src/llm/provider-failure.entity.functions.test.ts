import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { AiError } from "effect/ai"
import { ENGINE_KEY, modelFailureOf, stampAiErrorFailure } from "@xandreed/core"
import type { ProviderFailureEvidence, ProviderFailureProtocol } from "./provider-failure.entity.js"
import { classifyAiError, classifyProviderFailure } from "./provider-failure.entity.functions.js"

const kind = (evidence: Omit<ProviderFailureEvidence, "protocol">, protocol: ProviderFailureProtocol = "anthropic") => classifyProviderFailure({ protocol, ...evidence })

describe("provider failure evidence", () => {
  test("only Anthropic's exact context stop reason means overflow; ordinary output cuts remain unchanged", () => {
    expect(kind({ status: 200, stopReason: "model_context_window_exceeded" })).toEqual(Option.some("ContextOverflow"))
    ;["max_tokens", "length", "stop", "tool_use", "content_filter", "refusal"].forEach((stopReason) => expect(kind({ status: 200, stopReason })).toEqual(Option.none()))
    expect(kind({ stopReason: "model_context_window_exceeded" }, "openai")).toEqual(Option.none())
  })

  test("known context codes and narrowly supported provider messages distinguish token limits from request size", () => {
    expect(kind({ code: "context_length_exceeded", status: 400 }, "openai")).toEqual(Option.some("ContextOverflow"))
    expect(kind({ code: "context_length_exceeded" }, "compat")).toEqual(Option.some("ContextOverflow"))
    expect(kind({ type: "invalid_request_error", message: "prompt is too long: 1001 tokens > 1000 maximum", status: 400 })).toEqual(Option.some("ContextOverflow"))
    expect(kind({ message: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.", status: 400 }, "openai")).toEqual(Option.some("ContextOverflow"))
    expect(kind({ message: "input exceeds the context window", status: 413 }, "compat")).toEqual(Option.some("ContextOverflow"))
    expect(kind({ status: 413 })).toEqual(Option.some("InvalidRequest"))
    expect(kind({ status: 413, message: "request_too_large: request exceeds 32 MB" })).toEqual(Option.some("InvalidRequest"))
    expect(kind({ status: 400, message: "max_tokens must be less than the context window" })).toEqual(Option.some("InvalidRequest"))
    expect(kind({ status: 400, message: "thinking budget must be less than max_tokens" })).toEqual(Option.some("InvalidRequest"))
    expect(kind({ status: 400, message: "invalid thinking signature" })).toEqual(Option.some("InvalidRequest"))
  })

  test("structured auth, model rejection and billing evidence precede misleading gateway statuses", () => {
    expect(kind({ status: 401 })).toEqual(Option.some("Authentication"))
    expect(kind({ status: 403 })).toEqual(Option.some("Authentication"))
    expect(kind({ type: "authentication_error" })).toEqual(Option.some("Authentication"))
    expect(kind({ type: "permission_error" })).toEqual(Option.some("Authentication"))
    expect(kind({ type: "invalid_api_key_error" }, "openai")).toEqual(Option.some("Authentication"))
    expect(kind({ status: 401, type: "ModelError", message: "model is not supported" }, "compat")).toEqual(Option.some("InvalidRequest"))
    expect(kind({ status: 401, code: "insufficient_quota" }, "openai")).toEqual(Option.some("Quota"))
    ;["CreditsError", "insufficient_quota", "billing_insufficient_balance", "exceeded_current_quota_error"].forEach((code) => expect(kind({ status: 429, code }, "compat")).toEqual(Option.some("Quota")))
    expect(kind({ status: 402 })).toEqual(Option.some("Quota"))
  })

  test("ordinary rate limits, overloads and timeouts retain separate semantic kinds", () => {
    expect(kind({ status: 429 })).toEqual(Option.some("RateLimit"))
    expect(kind({ type: "rate_limit_error" })).toEqual(Option.some("RateLimit"))
    expect(kind({ code: "rate_limit_exceeded" }, "openai")).toEqual(Option.some("RateLimit"))
    expect(kind({ type: "overloaded_error" })).toEqual(Option.some("Transient"))
    expect(kind({ type: "api_error" })).toEqual(Option.some("Transient"))
    ;[500, 502, 503, 529].forEach((status) => expect(kind({ status })).toEqual(Option.some("Transient")))
    ;["anthropic", "openai", "compat"].forEach((protocol) => [408, 504].forEach((status) => expect(kind({ status }, protocol as ProviderFailureProtocol)).toEqual(Option.some("Timeout"))))
    expect(kind({ status: 504, type: "overloaded_error" })).toEqual(Option.some("Transient"))
    expect(kind({ status: 504, code: "rate_limit_exceeded" }, "openai")).toEqual(Option.some("RateLimit"))
    expect(kind({ status: 504, type: "invalid_request_error" })).toEqual(Option.some("InvalidRequest"))
    expect(kind({ code: "request_timeout" }, "openai")).toEqual(Option.some("Timeout"))
  })

  test("invalid requests and content-policy errors are permanent without inventing evidence", () => {
    ;[400, 404, 409, 413, 422].forEach((status) => expect(kind({ status })).toEqual(Option.some("InvalidRequest")))
    ;["invalid_request_error", "not_found_error", "request_too_large", "content_policy_violation"].forEach((type) => expect(kind({ type })).toEqual(Option.some("InvalidRequest")))
    expect(kind({ status: 200 })).toEqual(Option.none())
    expect(kind({ message: "an unknown error occurred" })).toEqual(Option.none())
    expect(kind({ code: "future_unrecognized_code" }, "openai")).toEqual(Option.none())
    expect(kind({ message: "prompt is too long", status: 401 })).toEqual(Option.some("Authentication"))
  })

  test("specific code, specific type, generic request envelope and HTTP status have deliberate precedence", () => {
    expect(kind({ status: 413, type: "request_too_large", message: "prompt is too long" })).toEqual(Option.some("InvalidRequest"))
    expect(kind({ status: 413, type: "request_too_large", message: "input exceeds the context window" })).toEqual(Option.some("InvalidRequest"))
    expect(kind({ status: 413, type: "request_too_large", code: "context_length_exceeded", message: "prompt is too long" })).toEqual(Option.some("ContextOverflow"))
    expect(kind({ status: 413, code: "request_too_large", type: "context_length_exceeded", message: "input exceeds the context window" })).toEqual(Option.some("InvalidRequest"))
    expect(kind({ status: 413, code: "prompt_too_long", type: "request_too_large", message: "prompt is too long" })).toEqual(Option.some("InvalidRequest"))
    expect(kind({ status: 413, message: "prompt is too long" })).toEqual(Option.some("InvalidRequest"))
    expect(kind({ status: 413, message: "input exceeds the context window" })).toEqual(Option.some("ContextOverflow"))
    expect(kind({ status: 429, type: "invalid_request_error", message: "invalid tool schema" }, "compat")).toEqual(Option.some("InvalidRequest"))
    expect(kind({ status: 429, type: "invalid_request_error", message: "input exceeds the context window" }, "compat")).toEqual(Option.some("ContextOverflow"))
    expect(kind({ status: 402, code: "invalid_api_key" }, "compat")).toEqual(Option.some("Authentication"))
    expect(kind({ status: 402, code: "invalid_api_key", type: "insufficient_quota" }, "compat")).toEqual(Option.some("Authentication"))
    expect(kind({ status: 401, code: "insufficient_quota", type: "authentication_error" }, "compat")).toEqual(Option.some("Quota"))
  })
})

describe("classifying pinned SDK AiErrors", () => {
  const http = (body: string, status = 400) => ({ request: { method: "POST" as const, url: "https://fixture.invalid/messages", urlParams: [], headers: {} }, response: { status, headers: { "request-id": "fixture-request" } }, body })
  test("structured context evidence refines neutral invalid-request without flattening reason classes", () => {
    const originalReason = new AiError.InvalidRequestError({
      description: "request refused", parameter: "input", http: http('{"error":{"code":"context_length_exceeded","message":"too much input"}}'),
      metadata: { openai: { requestId: "fixture" }, [ENGINE_KEY]: { model: "openai:fixture", sibling: 1 } },
    })
    const original = AiError.make({ module: "OpenAiClient", method: "createResponse", reason: originalReason })
    const classified = classifyAiError(original, "openai")
    expect(modelFailureOf(classified)).toEqual(Option.some("ContextOverflow"))
    expect(classified.reason._tag).toBe("InvalidRequestError")
    expect(classified.reason.isRetryable).toBe(false)
    expect(classified.cause).toBe(classified.reason)
    if (classified.reason._tag !== "InvalidRequestError") return
    expect(classified.reason.parameter).toBe("input")
    expect(classified.reason.http).toEqual(originalReason.http)
    const metadata: AiError.ProviderMetadata = classified.reason.metadata
    expect(metadata).toEqual({ openai: { requestId: "fixture" }, [ENGINE_KEY]: { model: "openai:fixture", sibling: 1, failure: "ContextOverflow" } })
    expect(originalReason.metadata[ENGINE_KEY]).toEqual({ model: "openai:fixture", sibling: 1 })
  })

  test("namespaced HTTP metadata and top-level socket metadata both retain precise context codes", () => {
    ;[{ openai: { errorCode: "context_length_exceeded" } }, { type: "invalid_request_error", code: "context_length_exceeded", message: "refused" }].forEach((metadata) => {
      const error = AiError.make({ module: "OpenAiClient", method: "createResponseStream", reason: new AiError.UnknownError({ metadata }) })
      expect(modelFailureOf(classifyAiError(error, "openai"))).toEqual(Option.some("ContextOverflow"))
    })
    const nestedBusinessData = AiError.make({ module: "AnthropicClient", method: "createMessage", reason: new AiError.InvalidRequestError({ description: "bad parameters", http: http('{"tool_result":{"message":"prompt is too long"}}') }) })
    expect(modelFailureOf(classifyAiError(nestedBusinessData, "anthropic"))).toEqual(Option.some("InvalidRequest"))
  })

  test("explicit stamps win even over malformed-output and stronger-looking provider data", () => {
    const stamped = stampAiErrorFailure(AiError.make({ module: "OpenAiClient", method: "createResponse", reason: new AiError.InvalidOutputError({ description: "decode failed", metadata: { openai: { errorCode: "context_length_exceeded" } } }) }), "InvalidResponse")
    expect(classifyAiError(stamped, "openai")).toBe(stamped)
    expect(modelFailureOf(classifyAiError(stamped, "openai"))).toEqual(Option.some("InvalidResponse"))
    const malformed = AiError.make({ module: "AnthropicLanguageModel", method: "makeResponse", reason: new AiError.InvalidOutputError({ description: "tool arguments are malformed" }) })
    expect(classifyAiError(malformed, "anthropic")).toBe(malformed)
    expect(modelFailureOf(classifyAiError(malformed, "anthropic"))).toEqual(Option.none())
  })

  test("the pinned client DecodeError/EmptyBody normalization is protocol failure, not model malformed output", () => {
    ;["createMessage", "createMessageStream"].forEach((method) => {
      const error = AiError.make({ module: "AnthropicClient", method, reason: new AiError.InvalidOutputError({ description: "response did not decode" }) })
      expect(modelFailureOf(classifyAiError(error, "anthropic"))).toEqual(Option.some("InvalidResponse"))
    })
    const unknown = AiError.make({ module: "Custom", method: "call", reason: new AiError.UnknownError({ description: "unknown" }) })
    expect(classifyAiError(unknown, "compat")).toBe(unknown)
  })
})
