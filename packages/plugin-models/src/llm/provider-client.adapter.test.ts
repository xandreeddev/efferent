import { describe, expect, test } from "bun:test"
import { Effect, Option, Redacted, Schema, Stream } from "effect"
import { AiError } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { modelFailureOf, parseModelSelection } from "@xandreed/core"
import { buildProvider } from "./providers.js"

const response = (error: unknown) => ({
  id: "resp_raw_failure", object: "response", model: "gpt-5.5", created_at: 0,
  output: [], error, usage: { input_tokens: 23, output_tokens: 4, total_tokens: 27 },
})
const context = { code: "context_length_exceeded", message: "Fixture context rejected." }

const call = (payload: unknown, streaming = false, object = false) => {
  const requests: Array<{ url: string; authorization: string | null }> = []
  // The reference replaces fetch itself; no native-provider network is used.
  const fetch = ((url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") })
    return Promise.resolve(streaming
      ? new Response((Array.isArray(payload) ? payload : [payload]).map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "x-request-id": "req_raw_failure" } })
      : Response.json(payload, { headers: { "x-request-id": "req_raw_failure" } }))
  }) as typeof globalThis.fetch
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const selection = yield* Effect.fromOption(parseModelSelection("openai:gpt-5.5"))
    const { svc } = yield* buildProvider(selection, undefined, Redacted.make("private-test-key"))
    const result = yield* Effect.result(streaming ? Stream.runDrain(svc.streamText({ prompt: "Inspect the failure." }))
      : object ? svc.generateObject({ prompt: "Inspect the failure.", schema: Schema.Struct({ ok: Schema.Boolean }) }).pipe(Effect.asVoid)
        : svc.generateText({ prompt: "Inspect the failure." }).pipe(Effect.asVoid))
    return { result, requests }
  })).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetch)))
}

describe("native Responses failure interception", () => {
  test.each([false, true])("settled object=%s catches a decoded error before normal SDK response handling", async (object) => {
    const { result, requests } = await call(response(context), false, object)
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure" || !AiError.isAiError(result.failure)) return
    const error = result.failure
    expect(modelFailureOf(error)).toEqual(Option.some("ContextOverflow"))
    expect(error.reason._tag).toBe("InvalidRequestError")
    expect(error.cause).toBe(error.reason)
    expect(requests).toEqual([{ url: "https://api.openai.com/v1/responses", authorization: "Bearer private-test-key" }])
    expect(JSON.stringify(error)).not.toContain("private-test-key")
    if (!("http" in error.reason)) return
    expect(error.reason.http?.request.headers).toEqual({})
    expect(JSON.parse(error.reason.http?.body ?? "{}")).toEqual(response(context))
    expect(error.reason.http?.response?.status).toBe(200)
  })

  test.each([
    { type: "error", code: "context_length_exceeded", message: "Fixture context rejected.", param: null },
    { type: "error", error: { code: "context_length_exceeded", message: "Fixture context rejected.", param: null } },
    { type: "response.failed", response: response(context) },
    { type: "response.completed", response: response(context) },
  ])("streamed $type retains an explicit context error instead of completing or becoming empty", async (event) => {
    const { result, requests } = await call(event, true)
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure" || !AiError.isAiError(result.failure)) return
    expect(modelFailureOf(result.failure)).toEqual(Option.some("ContextOverflow"))
    expect(requests).toHaveLength(1)
    expect(result.failure.cause).toBe(result.failure.reason)
    expect(JSON.stringify(result.failure)).not.toContain("private-test-key")
  })

  test.each([[401, "Authentication"], [429, "RateLimit"], [504, "Timeout"]] as const)("embedded SSE status %s is semantic evidence while actual HTTP status stays 200", async (status, kind) => {
    const { result, requests } = await call({ type: "error", code: null, message: "Opaque fixture refusal.", param: null, status }, true)
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure" || !AiError.isAiError(result.failure)) return
    expect(modelFailureOf(result.failure)).toEqual(Option.some(kind))
    expect(requests).toHaveLength(1)
    if (!("http" in result.failure.reason)) return
    expect(result.failure.reason.http?.response?.status).toBe(200)
  })

  test("a later raw SSE error retains usage already observed in a prior response event", async () => {
    const known = { input_tokens: 13, output_tokens: 2, total_tokens: 15 }
    const { result } = await call([
      { type: "response.created", response: { ...response(null), usage: known } },
      { type: "error", code: "context_length_exceeded", message: "Fixture context rejected.", param: null, status: 400 },
    ], true)
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure" || !AiError.isAiError(result.failure)) return
    expect(modelFailureOf(result.failure)).toEqual(Option.some("ContextOverflow"))
    if (!("http" in result.failure.reason)) return
    const raw = JSON.parse(result.failure.reason.http?.body ?? "{}")
    expect(raw.usage).toEqual(known)
    expect(raw.event.code).toBe("context_length_exceeded")
  })
})
