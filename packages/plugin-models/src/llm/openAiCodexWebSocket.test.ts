import { afterAll, describe, expect, test } from "bun:test"
import { Agent as HttpAgent } from "node:http"
import { OpenAiClient } from "@effect/ai-openai"
import { AiError } from "effect/ai"
import { Effect, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { BUN_WEBSOCKET_PROXY_VERSION } from "../transport/http-proxy.entity.js"
import { atLeastVersion } from "../transport/http-proxy.entity.functions.js"
import { startRecordingProxy } from "../transport/recording-proxy.testing.js"
import { makeOpenAiCodexWebSocketHttpClient, openAiCodexRefusal } from "./openAiCodexWebSocket.js"

/**
 * A Codex-shaped WebSocket server: answers each `response.create` with a text delta and `response.done`, echoing a
 * header it received; model `gpt-refused` gets an `error` refusing its image, `gpt-broken` a server error.
 */
const server = Bun.serve<{ readonly originator: string }>({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request, current) => current.upgrade(request, { data: { originator: request.headers.get("originator") ?? "none" } }) ? undefined : new Response("upgrade", { status: 426 }),
  websocket: {
    message: (socket, message) => {
      const created = JSON.parse(String(message)) as { readonly type?: string; readonly model?: string }
      if (created.model === "gpt-refused") {
        socket.send(JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", code: "invalid_image", message: "Invalid image: the image could not be processed." } }))
      } else if (created.model === "gpt-broken") {
        socket.send(JSON.stringify({ type: "error", status: 500, error: { type: "server_error", message: "The server had an error." } }))
      } else {
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: `${created.type} from ${socket.data.originator}` }))
        socket.send(JSON.stringify({ type: "response.done", response: { id: "r-1" } }))
      }
    },
  },
})
afterAll(() => server.stop(true))

/** One Codex request through the client, its SSE body as text. */
const exchange = (host: string, proxy: Parameters<typeof makeOpenAiCodexWebSocketHttpClient>[0], model = "gpt-test") =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const request = HttpClientRequest.post(`http://${host}:${server.port}/backend-api/codex/responses`).pipe(
      HttpClientRequest.setHeader("originator", "test"),
      HttpClientRequest.bodyJsonUnsafe({ model, prompt_cache_key: "conversation" }),
    )
    const response = yield* makeOpenAiCodexWebSocketHttpClient(proxy).execute(request)
    return yield* response.text
  })))

describe("the OpenAI subscription WebSocket client", () => {
  test("connects directly without a proxy and streams the events as SSE", async () => {
    const body = await exchange("127.0.0.1", Option.none())
    expect(body).toContain(`"delta":"response.create from test"`)
    expect(body).toContain(`"type":"response.completed"`)
  })

  // Below the gate the transport never hands out this route (CI runs this file on Bun 1.3.6 too).
  test.if(atLeastVersion(Bun.version, BUN_WEBSOCKET_PROXY_VERSION))(`goes through Bun's own WebSocket proxy option (Bun ${BUN_WEBSOCKET_PROXY_VERSION} and later)`, async () => {
    const proxy = await startRecordingProxy()
    const body = await exchange("models.proxy-test.invalid", Option.some({ _tag: "Proxy", url: Redacted.make(proxy.url) })).finally(proxy.close)
    expect(body).toContain("response.create from test")
    expect(proxy.seen).toEqual([{ kind: "connect", target: `models.proxy-test.invalid:${server.port}`, authorization: null }])
  })

  test("a request refused before any event fails with a 400 and its OpenAI error body: an InvalidRequestError naming the image", async () => {
    const status = await exchange("127.0.0.1", Option.none(), "gpt-refused").then(() => "streamed", (cause: unknown) => String(cause))
    expect(status).toContain("400")
    const error = await Effect.runPromise(Effect.gen(function* () {
      const client = yield* OpenAiClient.make({
        apiKey: Redacted.make("test"),
        transformClient: () => makeOpenAiCodexWebSocketHttpClient(Option.none()).pipe(
          HttpClient.mapRequest(HttpClientRequest.prependUrl(`http://127.0.0.1:${server.port}/backend-api/codex`))),
      })
      return yield* Effect.flip(client.createResponseStream({ model: "gpt-refused", input: [] } as never))
    }).pipe(Effect.provide(FetchHttpClient.layer)))
    expect(AiError.isAiError(error) ? error.reason._tag : "other").toBe("InvalidRequestError")
    expect(error.message).toContain("Invalid image: the image could not be processed.")
  })

  test("an error event that refuses nothing still fails the stream, as before", async () => {
    const outcome = await exchange("127.0.0.1", Option.none(), "gpt-broken").then(() => "streamed", (cause: unknown) => String(cause))
    expect(outcome).toContain("Decode error (200 POST")
  })

  test("openAiCodexRefusal: an invalid request or an image named, in either error shape; nothing else", () => {
    expect(openAiCodexRefusal({ type: "error", code: "invalid_request_error", message: "Unsupported image format", param: "input" }))
      .toEqual(Option.some({ error: { message: "Unsupported image format", type: "invalid_request_error", code: "invalid_request_error", param: "input" } }))
    expect(Option.isSome(openAiCodexRefusal({ type: "error", status: 400, error: { message: "bad request" } }))).toBe(true)
    expect(openAiCodexRefusal({ type: "error", status: 429, error: { type: "rate_limit_error", message: "slow down" } })).toEqual(Option.none())
    expect(openAiCodexRefusal({ type: "response.output_text.delta", delta: "an image" })).toEqual(Option.none())
  })

  test("refuses a route this runtime cannot use rather than connecting past the proxy", async () => {
    const agent = new HttpAgent()
    const error = await exchange("127.0.0.1", Option.some({ _tag: "Agent", agent })).then(
      () => "connected",
      (cause: unknown) => String(cause),
    ).finally(() => agent.destroy())
    expect(error).toContain("the WebSocket route is a Node agent, which Bun's WebSocket cannot use: refused rather than connecting directly past the proxy")
  })
})
