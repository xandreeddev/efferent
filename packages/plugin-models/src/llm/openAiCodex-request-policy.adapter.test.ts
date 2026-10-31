import { afterAll, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Option, Redacted } from "effect"
import { AiError } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { modelFailureOf } from "@xandreed/core"
import { CurrentModelRetryPolicy } from "../ports/model-retry-policy.port.js"
import type { ModelRetryPolicy } from "./model-retry-policy.entity.js"
import { makeOpenAiCodexLanguageModel } from "./openAiCodex.js"

const requests: Array<{ readonly model: string; readonly type: string; readonly stream: boolean; readonly store: boolean }> = []
const closed: string[] = []
const destinations: string[] = []
const server = Bun.serve<{ readonly session: string }>({
  hostname: "127.0.0.1", port: 0,
  fetch: (request, current) => current.upgrade(request, { data: { session: request.headers.get("session-id") ?? "missing" } })
    ? undefined : new Response("upgrade required", { status: 426 }),
  websocket: {
    message: (socket, bytes) => {
      const request = JSON.parse(String(bytes)) as { model: string; type: string; stream: boolean; store: boolean }
      requests.push(request)
      if (request.model === "gpt-waits") return
      if (request.model === "gpt-context") {
        socket.send(JSON.stringify({ type: "error", status: 429, error: { type: "invalid_request_error", code: "context_length_exceeded", message: "fixture context refused" } }))
        return
      }
      if (request.model === "gpt-retries" && requests.filter(({ model }) => model === request.model).length === 1) {
        socket.send(JSON.stringify({ type: "error", status: 503, error: { type: "server_error", message: "fixture unavailable" } }))
        return
      }
      socket.send(JSON.stringify({ type: "response.output_text.delta", item_id: "fixture-message", output_index: 0, content_index: 0, delta: "finished" }))
      if (request.model === "gpt-idles") return
      if (request.model === "gpt-context-late") {
        socket.send(JSON.stringify({ type: "error", error: { type: "invalid_request_error", code: "context_length_exceeded", message: "fixture context refused" } }))
        return
      }
      socket.send(JSON.stringify({ type: "response.done", response: {
        id: "fixture-response", object: "response", model: request.model, created_at: 0,
        output: [], error: null, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      } }))
    },
    close: (socket) => { closed.push(socket.data.session) },
  },
})
afterAll(() => { void server.stop(true) })

const call = (model: string, maxAttempts = 3) => {
  const original = globalThis.WebSocket
  const redirect = new Proxy(original, {
    construct: (_target, args) => {
      destinations.push(String(args[0]))
      // The explicit Proxy route selects Bun's public constructor. Redirect
      // that constructor to this fixture, omitting its unused proxy setting.
      const options = args[1] as { headers?: Record<string, string> } | undefined
      return Reflect.construct(original, [`ws://127.0.0.1:${server.port}/fixture`, { headers: options?.headers }])
    },
  })
  const policy: ModelRetryPolicy = {
    maxAttempts, requestTimeoutMs: 200, bodyIdleTimeoutMs: 50,
    totalTimeoutMs: 800, retryAfterMaxMs: 0,
    backoff: { initialMs: 0, maxMs: 0, jitter: 0 },
  }
  return Effect.runPromise(Effect.acquireUseRelease(
    Effect.sync(() => { globalThis.WebSocket = redirect }),
    () => Effect.scoped(Effect.gen(function* () {
      const languageModel = yield* makeOpenAiCodexLanguageModel({
        model, accessToken: Redacted.make("fixture-private-token"), accountId: "fixture-account",
        webSocketProxy: Option.some({ _tag: "Proxy", url: Redacted.make("http://unused.invalid") }),
      })
      return yield* languageModel.generateText({ prompt: "hello" }).pipe(Effect.exit)
    })).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(CurrentModelRetryPolicy, policy), Effect.timeoutOption("2 seconds")),
    () => Effect.sync(() => { globalThis.WebSocket = original }),
  ))
}

describe("Codex final WebSocket request policy", () => {
  test("retries a first-frame transient refusal after final subscription transformations", async () => {
    const result = await call("gpt-retries")
    expect(Option.isSome(result)).toBe(true)
    if (Option.isSome(result)) {
      expect(Exit.isSuccess(result.value)).toBe(true)
      if (Exit.isSuccess(result.value)) expect(result.value.value.text).toBe("finished")
    }
    const sent = requests.filter(({ model }) => model === "gpt-retries")
    expect(sent).toHaveLength(2)
    expect(sent.every(({ type, stream, store }) => type === "response.create" && stream === true && store === false)).toBe(true)
    expect(destinations.every((url) => url === "wss://chatgpt.com/backend-api/codex/responses")).toBe(true)
  })

  test.each(["gpt-waits", "gpt-idles"])("%s preserves Timeout and closes the socket without post-handoff retries", async (model) => {
    const beforeClosed = closed.length
    const result = await call(model, model === "gpt-waits" ? 1 : 3)
    expect(Option.isSome(result)).toBe(true)
    if (Option.isSome(result)) {
      expect(Exit.isFailure(result.value)).toBe(true)
      if (Exit.isFailure(result.value)) expect(modelFailureOf(Cause.squash(result.value.cause))).toEqual(Option.some("Timeout"))
    }
    expect(requests.filter((request) => request.model === model)).toHaveLength(1)
    await Bun.sleep(5)
    expect(closed.length).toBeGreaterThan(beforeClosed)
  })

  test.each(["gpt-context", "gpt-context-late"])("%s keeps the permanent raw provider failure and makes one request", async (model) => {
    const result = await call(model)
    expect(Option.isSome(result)).toBe(true)
    if (Option.isSome(result)) {
      expect(Exit.isFailure(result.value)).toBe(true)
      if (Exit.isFailure(result.value)) {
        const error = Cause.squash(result.value.cause)
        expect(modelFailureOf(error)).toEqual(Option.some("ContextOverflow"))
        expect(AiError.isAiError(error) && error.reason._tag).toBe("InvalidRequestError")
        expect(JSON.stringify(error)).not.toContain("fixture-private-token")
      }
    }
    expect(requests.filter((request) => request.model === model)).toHaveLength(1)
  })
})
