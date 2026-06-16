import { test, expect } from "bun:test"
import { formatFullError, inspectError } from "./errorFormat.js"

/**
 * A faithful-ish mock of what `@effect/ai-openai` surfaces for a 401
 * `token_revoked` (a revoked ChatGPT/Codex subscription token): an outer
 * `AiError` wrapping an `HttpClientError.ResponseError`. The `cause` chain
 * carries a request (with an `authorization: Bearer …` header), a response,
 * and a body that's already embedded — verbatim — in the error `message`.
 * This is the shape that made `inspect(depth:10)` dump ~75 lines into the rail.
 */
const authError = (): unknown => {
  const body = JSON.stringify(
    {
      error: {
        message: "Encountered invalidated oauth token for user, failing request",
        type: null,
        code: "token_revoked",
        param: null,
      },
      status: 401,
    },
    null,
    2,
  )
  const responseError: Record<string, unknown> = {
    _tag: "ResponseError",
    name: "ResponseError",
    reason: "StatusCode",
    description: body,
    request: {
      _tag: "HttpClientRequest",
      method: "POST",
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: {
        authorization: "Bearer sk-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "content-type": "application/json",
      },
      body: { _tag: "Uint8Array", length: 84213 },
    },
    response: { _tag: "HttpClientResponse", status: 401, headers: {} },
  }
  responseError.message =
    `StatusCode: ${body} (401 POST https://chatgpt.com/backend-api/codex/responses)\n\n` +
    `Unauthorized - Verify API key, authentication credentials, or token expiration.\n\n` +
    `Response Body: ${body}`
  const aiError: Record<string, unknown> = {
    _tag: "AiError",
    name: "AiError",
    module: "OpenAiLanguageModel",
    method: "generateText",
    description: "an error occurred",
    cause: responseError,
  }
  aiError.message = "OpenAiLanguageModel.generateText: an error occurred"
  return aiError
}

test("formatFullError renders a provider 401 as a compact, actionable rail message", () => {
  const out = formatFullError(authError())
  // Surface the rendered output so the test run literally shows it.
  console.log("\n--- formatFullError(401) ---\n" + out + "\n----------------------------")
  console.log(`lines=${out.split("\n").length} chars=${out.length}`)

  // It must stay small enough to read as one rail block, not flood the pane.
  expect(out.split("\n").length).toBeLessThanOrEqual(6)
  expect(out.length).toBeLessThan(500)

  // It must NOT leak the credential into the visible UI.
  expect(out).not.toContain("Bearer")
  expect(out.toLowerCase()).not.toContain("authorization")

  // It must name the real cause and tell the user what to do about it.
  expect(out.toLowerCase()).toMatch(/unauthorized|token|401/)
  expect(out.toLowerCase()).toMatch(/:login|:model|credential/)
})

test("formatFullError passes a plain message through untouched", () => {
  expect(formatFullError(new Error("boom: provider 500"))).toBe("boom: provider 500")
  expect(formatFullError("just a string")).toBe("just a string")
})

test("inspectError keeps the full nested detail for the log file", () => {
  const deep = inspectError(authError())
  // The log path is allowed to be verbose — that's where you go to debug.
  expect(deep).toContain("ResponseError")
  expect(deep).toContain("token_revoked")
})
