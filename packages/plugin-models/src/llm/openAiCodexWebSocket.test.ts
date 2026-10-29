import { afterAll, describe, expect, test } from "bun:test"
import { Agent as HttpAgent } from "node:http"
import { Effect, Option, Redacted } from "effect"
import { HttpClientRequest } from "effect/http"
import { BUN_WEBSOCKET_PROXY_VERSION } from "../transport/http-proxy.entity.js"
import { atLeastVersion } from "../transport/http-proxy.entity.functions.js"
import { startRecordingProxy } from "../transport/recording-proxy.testing.js"
import { makeOpenAiCodexWebSocketHttpClient } from "./openAiCodexWebSocket.js"

/** A Codex-shaped WebSocket server: answers each `response.create` with a text delta and `response.done`, echoing a header it received. */
const server = Bun.serve<{ readonly originator: string }>({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request, current) => current.upgrade(request, { data: { originator: request.headers.get("originator") ?? "none" } }) ? undefined : new Response("upgrade", { status: 426 }),
  websocket: {
    message: (socket, message) => {
      const created = JSON.parse(String(message)) as { readonly type?: string }
      socket.send(JSON.stringify({ type: "response.output_text.delta", delta: `${created.type} from ${socket.data.originator}` }))
      socket.send(JSON.stringify({ type: "response.done", response: { id: "r-1" } }))
    },
  },
})
afterAll(() => server.stop(true))

/** One Codex request through the client, its SSE body as text. */
const exchange = (host: string, proxy: Parameters<typeof makeOpenAiCodexWebSocketHttpClient>[0]) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const request = HttpClientRequest.post(`http://${host}:${server.port}/backend-api/codex/responses`).pipe(
      HttpClientRequest.setHeader("originator", "test"),
      HttpClientRequest.bodyJsonUnsafe({ model: "gpt-test", prompt_cache_key: "conversation" }),
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

  test("refuses a route this runtime cannot use rather than connecting past the proxy", async () => {
    const agent = new HttpAgent()
    const error = await exchange("127.0.0.1", Option.some({ _tag: "Agent", agent })).then(
      () => "connected",
      (cause: unknown) => String(cause),
    ).finally(() => agent.destroy())
    expect(error).toContain("the WebSocket route is a Node agent, which Bun's WebSocket cannot use: refused rather than connecting directly past the proxy")
  })
})
