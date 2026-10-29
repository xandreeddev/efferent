import { afterAll, describe, expect, test } from "bun:test"
import { Agent as HttpAgent } from "node:http"
import { OpenAiClient } from "@effect/ai-openai"
import { AiError } from "effect/ai"
import { Cache, Effect, Option, Redacted, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { BUN_WEBSOCKET_PROXY_VERSION } from "../transport/http-proxy.entity.js"
import { atLeastVersion } from "../transport/http-proxy.entity.functions.js"
import { startRecordingProxy } from "../transport/recording-proxy.testing.js"
import { mapOpenAiCodexError } from "./openAiCodex.js"
import { makeOpenAiCodexSessions, makeOpenAiCodexWebSocketHttpClient, openAiCodexRefusal } from "./openAiCodexWebSocket.js"
import type { OpenAiCodexSessions } from "./openAiCodexWebSocket.js"

/** The sockets open on the server, by session id, so a test can tell the client closed its own. */
const open = new Set<string>()

/**
 * A Codex-shaped WebSocket server: answers each `response.create` with a text delta naming its type, the originator
 * and the session id it received, then `response.done`. Some models answer otherwise: `gpt-refused` an `error`
 * refusing its image, `gpt-broken` a server error, `gpt-quota` an exhausted quota, `gpt-ends` a delta and a normal
 * close with no terminal event, `gpt-silent` a normal close at once, `gpt-garbage` a frame that is no JSON event,
 * `gpt-fails-late` a delta and then an error, `gpt-waits` nothing.
 */
const server = Bun.serve<{ readonly originator: string; readonly session: string }>({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request, current) => current.upgrade(request, {
    data: { originator: request.headers.get("originator") ?? "none", session: request.headers.get("session-id") ?? "none" },
  }) ? undefined : new Response("upgrade", { status: 426 }),
  websocket: {
    message: (socket, message) => {
      const created = JSON.parse(String(message)) as { readonly type?: string; readonly model?: string }
      const delta = JSON.stringify({ type: "response.output_text.delta", delta: `${created.type} from ${socket.data.originator} in ${socket.data.session}` })
      if (created.model === "gpt-refused") {
        socket.send(JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", code: "invalid_image", message: "Invalid image: the image could not be processed." } }))
      } else if (created.model === "gpt-broken") {
        socket.send(JSON.stringify({ type: "error", status: 500, error: { type: "server_error", message: "The server had an error." } }))
      } else if (created.model === "gpt-quota") {
        socket.send(JSON.stringify({ type: "error", status: 429, error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota." } }))
      } else if (created.model === "gpt-ends") {
        socket.send(delta)
        socket.close(1000, "done early")
      } else if (created.model === "gpt-silent") {
        socket.close(1000, "nothing to say")
      } else if (created.model === "gpt-garbage") {
        socket.send("this is no event")
      } else if (created.model === "gpt-waits") {
        return
      } else if (created.model === "gpt-fails-late") {
        socket.send(delta)
        socket.send(JSON.stringify({ type: "error", error: { type: "server_error", message: "lost the thread" } }))
      } else {
        socket.send(JSON.stringify({ type: "codex.rate_limits", primary: {} }))
        socket.send(delta)
        socket.send(JSON.stringify({ type: "response.done", response: { id: "r-1" } }))
      }
    },
    open: (socket) => {
      open.add(socket.data.session)
    },
    close: (socket) => {
      open.delete(socket.data.session)
    },
  },
})
// Not awaited: after a socket the server closed itself, Bun's `stop` does not settle.
afterAll(() => {
  void server.stop(true)
})

/** One Codex request through the client, its SSE body as text (no exchange may take 1 second: a hang fails). */
const exchange = (
  host: string,
  proxy: Parameters<typeof makeOpenAiCodexWebSocketHttpClient>[0],
  model = "gpt-test",
  sessions: Option.Option<OpenAiCodexSessions> = Option.none(),
  cacheKey = "conversation",
) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const request = HttpClientRequest.post(`http://${host}:${server.port}/backend-api/codex/responses`).pipe(
      HttpClientRequest.setHeader("originator", "test"),
      HttpClientRequest.bodyJsonUnsafe({ model, prompt_cache_key: cacheKey }),
    )
    const response = yield* makeOpenAiCodexWebSocketHttpClient(proxy, sessions).execute(request)
    return yield* response.text
  }).pipe(Effect.timeout("1 second"))))

/** The error a Codex model call through the OpenAI client fails with, after the subscription's own mapping. */
const streamError = (model: string) => Effect.runPromise(Effect.gen(function* () {
  const client = yield* OpenAiClient.make({
    apiKey: Redacted.make("test"),
    transformClient: () => makeOpenAiCodexWebSocketHttpClient(Option.none()).pipe(
      HttpClient.mapRequest(HttpClientRequest.prependUrl(`http://127.0.0.1:${server.port}/backend-api/codex`))),
  })
  const [, events] = yield* client.createResponseStream({ model, input: [] } as never)
  return yield* Effect.flip(Stream.runDrain(events))
}).pipe(
  Effect.catch((error) => Effect.succeed(error)),
  Effect.map((error) => mapOpenAiCodexError(model, error)),
  Effect.provide(FetchHttpClient.layer),
  Effect.timeout("5 seconds"),
))

const reasonOf = (error: unknown): string => AiError.isAiError(error) ? error.reason._tag : "other"

describe("the OpenAI subscription WebSocket client", () => {
  test("connects directly without a proxy and streams the events as SSE, control events left out", async () => {
    const body = await exchange("127.0.0.1", Option.none())
    expect(body).toContain(`"delta":"response.create from test`)
    expect(body).toContain(`"type":"response.completed"`)
    expect(body).not.toContain("codex.rate_limits")
  })

  test.if(atLeastVersion(Bun.version, BUN_WEBSOCKET_PROXY_VERSION))(`goes through Bun's own WebSocket proxy option (Bun ${BUN_WEBSOCKET_PROXY_VERSION} and later)`, async () => {
    const proxy = await startRecordingProxy()
    const body = await exchange("models.proxy-test.invalid", Option.some({ _tag: "Proxy", url: Redacted.make(proxy.url) })).finally(proxy.close)
    expect(body).toContain("response.create from test")
    expect(proxy.seen).toEqual([{ kind: "connect", target: `models.proxy-test.invalid:${server.port}`, authorization: null }])
  })

  test("a request refused before any event fails with a 400 and its OpenAI error body: an InvalidRequestError naming the image", async () => {
    const status = await exchange("127.0.0.1", Option.none(), "gpt-refused").then(() => "streamed", (cause: unknown) => String(cause))
    expect(status).toContain("400")
    const error = await streamError("gpt-refused")
    expect(reasonOf(error)).toBe("InvalidRequestError")
    expect(String(error)).toContain("Invalid image: the image could not be processed.")
  })

  test("any other error before the first event is answered with its status: a server error is retryable, an exhausted quota is not", async () => {
    expect(await exchange("127.0.0.1", Option.none(), "gpt-broken").then(() => "streamed", (cause: unknown) => String(cause))).toContain("500")
    const broken = await streamError("gpt-broken")
    expect(reasonOf(broken)).toBe("InternalProviderError")
    expect(AiError.isAiError(broken) && broken.isRetryable).toBe(true)
    const quota = await streamError("gpt-quota")
    expect(reasonOf(quota)).toBe("QuotaExhaustedError")
    expect(AiError.isAiError(quota) && quota.isRetryable).toBe(false)
  })

  test("a normal close from the server ends the stream instead of hanging it, and before any event fails the request", async () => {
    const body = await exchange("127.0.0.1", Option.none(), "gpt-ends")
    expect(body).toContain("response.create from test")
    expect(body).not.toContain("response.completed")
    const silent = await exchange("127.0.0.1", Option.none(), "gpt-silent").then(() => "streamed", (cause: unknown) => String(cause))
    expect(silent).toContain("the socket closed before the first event")
  })

  test("a frame that is no JSON event, or an error once the stream began, fails it as a provider protocol failure, not the model's invalid output", async () => {
    expect(reasonOf(await streamError("gpt-garbage"))).toBe("InvalidResponseError")
    expect(reasonOf(await streamError("gpt-fails-late"))).toBe("InvalidResponseError")
  })

  test("closes its socket once the stream has ended, failed or been refused", async () => {
    await exchange("127.0.0.1", Option.none())
    await streamError("gpt-fails-late")
    await streamError("gpt-refused")
    expect(await exchange("127.0.0.1", Option.none(), "gpt-waits").then(() => "answered", (cause: unknown) => String(cause))).toContain("TimeoutError")
    await Bun.sleep(100)
    expect([...open]).toEqual([])
  })

  test("keeps one session id per conversation, at most `capacity` of them: the least recently used is dropped", async () => {
    const sessions = await Effect.runPromise(makeOpenAiCodexSessions(2))
    const sessionOf = async (key: string) => (await exchange("127.0.0.1", Option.none(), "gpt-test", Option.some(sessions), key)).match(/ in ([0-9a-f-]{36})/)?.[1]
    const first = await sessionOf("a")
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(await sessionOf("a")).toBe(first)
    const second = await sessionOf("b")
    expect(second).not.toBe(first)
    await sessionOf("c")
    expect(await Effect.runPromise(Cache.size(sessions))).toBe(2)
    expect(await sessionOf("a")).not.toBe(first)
    // Without a cache, every request gets a fresh id.
    const fresh = await Promise.all([1, 2].map(() => exchange("127.0.0.1", Option.none())))
    expect(fresh[0]).not.toBe(fresh[1])
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
