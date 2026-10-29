import { describe, expect, test } from "bun:test"
import { AiError } from "effect/ai"
import { AuthError } from "../ports/auth-store.port.js"
import { toAgentFailure } from "./agent-failure.entity.functions.js"

const request = { method: "POST" as const, url: "https://provider.test/v1/responses", urlParams: [], hash: undefined, headers: {} }
const answered = (status: number) => ({ request, response: { status, headers: {} } })
const aiError = (reason: AiError.AiErrorReason) => AiError.make({ module: "Provider", method: "generateText", reason })
const classified = (error: unknown) => {
  const { code, category, retryable } = toAgentFailure(error, "model")
  return { code, category, retryable }
}

describe("toAgentFailure", () => {
  test("an effect/ai error is classified by its reason, retryable as the reason says", () => {
    expect(classified(aiError(new AiError.RateLimitError({ http: answered(429) })))).toEqual({ code: "RateLimitError:429", category: "rate-limit", retryable: true })
    expect(classified(aiError(new AiError.QuotaExhaustedError({})))).toEqual({ code: "QuotaExhaustedError", category: "rate-limit", retryable: false })
    expect(classified(aiError(new AiError.AuthenticationError({ kind: "MissingKey" })))).toEqual({ code: "AuthenticationError", category: "authentication", retryable: false })
    expect(classified(aiError(new AiError.AuthenticationError({ kind: "InsufficientPermissions", http: answered(403) }))))
      .toEqual({ code: "AuthenticationError:403", category: "authorization", retryable: false })
    expect(classified(aiError(new AiError.InvalidResponseError({ description: "the stream frame is not JSON" }))))
      .toEqual({ code: "InvalidResponseError", category: "protocol", retryable: false })
    expect(classified(aiError(new AiError.InternalProviderError({ description: "overloaded", http: answered(503) }))))
      .toEqual({ code: "InternalProviderError:503", category: "transport", retryable: true })
    expect(classified(new AiError.NetworkError({ reason: "TransportError", request }))).toEqual({ code: "NetworkError", category: "transport", retryable: true })
  })

  test("the provider's wording decides only what no reason names, never a typed reason's category", () => {
    // "timed out" in the text of a non-retryable reason does not make it a retryable timeout.
    expect(classified(aiError(new AiError.InvalidRequestError({ description: "the tool call timed out in validation" }))))
      .toEqual({ code: "InvalidRequestError", category: "protocol", retryable: false })
    expect(classified(aiError(new AiError.InvalidRequestError({ description: "The model gpt-x is not supported" }))))
      .toEqual({ code: "ModelUnsupported", category: "validation", retryable: false })
  })

  test("anything else by its tag and status, its message last", () => {
    expect(classified(new AuthError({ provider: "openai", message: "no credentials" }))).toEqual({ code: "AuthError", category: "authentication", retryable: false })
    expect(classified({ _tag: "FetchError", status: 502 })).toEqual({ code: "FetchError:502", category: "transport", retryable: true })
    expect(classified(new Error("the request timed out"))).toEqual({ code: "Error", category: "timeout", retryable: true })
  })
})
