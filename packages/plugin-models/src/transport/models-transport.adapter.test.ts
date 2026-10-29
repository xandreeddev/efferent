import { afterAll, describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Exit, Option, Redacted } from "effect"
import type { Context } from "effect"
import { ModelsTransport } from "../ports/models-transport.port.js"
import { BUN_WEBSOCKET_PROXY_VERSION, ProxyInvalid, ProxyUnsupported } from "./http-proxy.entity.js"
import { atLeastVersion } from "./http-proxy.entity.functions.js"
import { ModelsTransportLive, modelsTransportFor, transportFetch } from "./models-transport.adapter.js"
import { ambientProxy, closedPort, startRecordingProxy } from "./recording-proxy.testing.js"

/** A target on 127.0.0.1 answering every request with its method and path. */
const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => new Response(`target saw ${request.method} ${new URL(request.url).pathname}`) })
afterAll(() => target.stop(true))

/** A host only the recording proxy can reach (it maps `*.invalid` to 127.0.0.1); fetched directly, it does not resolve. */
const viaProxyOnly = (path: string) => `http://models.proxy-test.invalid:${target.port}${path}`

/** The transport of these options over this environment, provided around its whole use (its pools close with the layer). */
const withTransport = <A>(
  options: Parameters<typeof ModelsTransportLive>[0],
  env: Record<string, string>,
  use: (transport: Context.Service.Shape<typeof ModelsTransport>) => Promise<A>,
) => Effect.runPromise(Effect.gen(function* () {
  const transport = yield* Effect.service(ModelsTransport)
  return yield* Effect.promise(() => use(transport))
}).pipe(Effect.provide(ModelsTransportLive(options)), Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }))))

const text = (response: Promise<Response>) => response.then((value) => value.text())
const failure = (response: Promise<Response>) => response.then(() => "succeeded", (error: unknown) => error instanceof Error ? error.message : String(error))

describe("ModelsTransportLive without a proxy", () => {
  // Bun's fetch would send this direct request to a proxy from the machine's environment.
  test.skipIf(ambientProxy)("is the global fetch, and WebSockets connect directly", async () => {
    const reply = await withTransport({}, {}, (transport) => {
      expect(transport.webSocketAgent).toBeUndefined()
      return text(transport.fetch(`http://127.0.0.1:${target.port}/plain`))
    })
    expect(reply).toBe("target saw GET /plain")
  })

  test("the plugin adds no transport when no proxy applies, nor on Bun when noProxy turns it off", async () => {
    const found = (options: Parameters<typeof modelsTransportFor>[0], env: Record<string, string>) => Effect.runPromise(Effect.scoped(modelsTransportFor(options)).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
      Effect.map(Option.isSome),
    ))
    expect(await found({}, {})).toBe(false)
    // On Node, `*` is a transport over undici's direct agent (scripts/proxy-consumer.fixture.mjs); Bun's fetch has no per-request way to stay direct.
    expect(await found({ noProxy: "*" }, { HTTPS_PROXY: "http://proxy.example:3128" })).toBe(false)
    expect(await found({}, { HTTPS_PROXY: "http://proxy.example:3128" })).toBe(true)
  })
})

describe("ModelsTransportLive through a recording proxy", () => {
  test("a model call to a host only the proxy reaches goes through the proxy option, with its credentials", async () => {
    const proxy = await startRecordingProxy()
    const reply = await withTransport({ proxy: Redacted.make(`http://user:secret@127.0.0.1:${proxy.port}`) }, {}, (transport) =>
      text(transport.fetch(viaProxyOnly("/v1/chat/completions"), { method: "POST", body: "{}" })),
    ).finally(proxy.close)
    expect(reply).toBe("target saw POST /v1/chat/completions")
    // Bun sends an http: target to the proxy in absolute form; Node's undici tunnels it with CONNECT.
    expect(proxy.seen).toEqual([{ kind: "absolute", target: viaProxyOnly("/v1/chat/completions"), authorization: `Basic ${btoa("user:secret")}` }])
  })

  test("HTTP_PROXY from the environment applies when the option is empty", async () => {
    const proxy = await startRecordingProxy()
    const reply = await withTransport({}, { HTTP_PROXY: proxy.url }, (transport) => text(transport.fetch(new URL(viaProxyOnly("/env")))))
      .finally(proxy.close)
    expect(reply).toBe("target saw GET /env")
    expect(proxy.seen.map((request) => request.target)).toEqual([viaProxyOnly("/env")])
  })

  test("an https target is tunnelled with CONNECT; the proxy's refusal reaches the caller", async () => {
    const proxy = await startRecordingProxy()
    const outcome = await withTransport({}, { HTTPS_PROXY: proxy.url }, (transport) => transport.fetch("https://api.anthropic.com/v1/messages").then(
      (response) => `status ${response.status}`,
      (error: unknown) => error instanceof Error ? error.message : String(error),
    )).finally(proxy.close)
    expect(proxy.seen).toEqual([{ kind: "connect", target: "api.anthropic.com:443", authorization: null }])
    // Bun hands back the proxy's refusal (403) as the response, which cannot be told from the provider's own.
    expect(outcome).toBe("status 403")
  })

  test("a proxy asking for credentials (407) fails the request, naming the proxy, for https and http targets", async () => {
    const proxy = await startRecordingProxy({ authenticate: true })
    const messages = await withTransport({ proxy: Redacted.make(`http://user:wrong@127.0.0.1:${proxy.port}`) }, {}, (transport) => Promise.all([
      failure(transport.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" })),
      failure(transport.fetch(viaProxyOnly("/v1/chat/completions"))),
    ])).finally(proxy.close)
    expect(messages).toEqual([
      `the request to https://api.anthropic.com through the proxy http://<redacted>@127.0.0.1:${proxy.port} failed: the proxy refused its credentials (407 Proxy Authentication Required)`,
      `the request to http://models.proxy-test.invalid:${target.port} through the proxy http://<redacted>@127.0.0.1:${proxy.port} failed: the proxy refused its credentials (407 Proxy Authentication Required)`,
    ])
    expect(proxy.seen.map((request) => request.target)).toEqual(["api.anthropic.com:443", viaProxyOnly("/v1/chat/completions")])
  })

  test("a .invalid target through a proxy that is not there fails with a clear error, credentials redacted", async () => {
    const port = await closedPort()
    const message = await withTransport({ proxy: `http://user:secret@127.0.0.1:${port}` }, {}, (transport) => failure(transport.fetch(viaProxyOnly("/dead"))))
    expect(message).toContain(`the request to http://models.proxy-test.invalid:${target.port} through the proxy http://<redacted>@127.0.0.1:${port} failed`)
    expect(message).not.toContain("secret")
  })

  test("a proxy that resets every connection fails the request at once", async () => {
    const proxy = await startRecordingProxy({ reset: true })
    const started = Date.now()
    const message = await withTransport({ proxy: proxy.url }, {}, (transport) => failure(transport.fetch("https://api.anthropic.com/v1/messages")))
      .finally(proxy.close)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(message).toContain(`through the proxy ${proxy.url} failed`)
  })

  test("the noProxy option and NO_PROXY send their hosts direct", async () => {
    const proxy = await startRecordingProxy()
    const messages = await withTransport({ proxy: proxy.url, noProxy: "direct.proxy-test.invalid" }, { NO_PROXY: ".env-direct.invalid" }, (transport) => Promise.all([
      failure(transport.fetch(`http://direct.proxy-test.invalid:${target.port}/a`)),
      failure(transport.fetch(`http://api.env-direct.invalid:${target.port}/b`)),
    ])).finally(proxy.close)
    // Direct, a .invalid host does not resolve: the request fails without a proxy in its message, and the proxy saw nothing.
    expect(messages.every((message) => message !== "succeeded" && !message.includes("through the proxy"))).toBe(true)
    expect(proxy.seen).toEqual([])
  })

  // A proxy in the machine's environment would still take this request on Bun (only NO_PROXY exempts a host from it there).
  test.skipIf(ambientProxy)("loopback hosts always go direct", async () => {
    const proxy = await startRecordingProxy()
    const reply = await withTransport({ proxy: proxy.url }, {}, (transport) => text(transport.fetch(`http://127.0.0.1:${target.port}/local`)))
      .finally(proxy.close)
    expect(reply).toBe("target saw GET /local")
    expect(proxy.seen).toEqual([])
  })

  test("as FetchHttpClient.Fetch takes it, a Request goes through the proxy whole", async () => {
    const proxy = await startRecordingProxy()
    const reply = await withTransport({ proxy: proxy.url }, {}, (transport) =>
      text(transportFetch(transport)(new Request(viaProxyOnly("/request"), { method: "PUT", body: "payload" }))),
    ).finally(proxy.close)
    expect(reply).toBe("target saw PUT /request")
    expect(proxy.seen.map((request) => request.target)).toEqual([viaProxyOnly("/request")])
  })
})

describe("ModelsTransportLive WebSockets", () => {
  /** The routes the transport gives a loopback WebSocket and the subscription's. */
  const routes = () => withTransport({ proxy: "http://user:secret@proxy.example:3128" }, {}, (transport) => Effect.runPromise(Effect.gen(function* () {
    const route = Option.getOrThrow(Option.fromNullishOr(transport.webSocketAgent))
    return {
      loopback: yield* route(new URL("ws://127.0.0.1:9/socket")),
      chatgpt: yield* Effect.exit(route(new URL("wss://chatgpt.com/backend-api/codex/responses"))),
    }
  })))
  const tunnels = atLeastVersion(Bun.version, BUN_WEBSOCKET_PROXY_VERSION)

  test.if(tunnels)(`from Bun ${BUN_WEBSOCKET_PROXY_VERSION}, a proxied WebSocket uses Bun's own proxy option; a loopback one connects directly`, async () => {
    const results = await routes()
    expect(Option.isNone(results.loopback)).toBe(true)
    const route = Option.getOrThrow(Option.flatten(Exit.getSuccess(results.chatgpt)))
    expect(route._tag === "Proxy" && Redacted.value(route.url)).toBe("http://user:secret@proxy.example:3128/")
  })

  test.skipIf(tunnels)(`below Bun ${BUN_WEBSOCKET_PROXY_VERSION}, a proxied WebSocket is refused; a loopback one connects directly`, async () => {
    const results = await routes()
    expect(Option.isNone(results.loopback)).toBe(true)
    const error = Option.getOrThrow(Exit.findErrorOption(results.chatgpt))
    expect(error).toBeInstanceOf(ProxyUnsupported)
    expect(error.message).toContain(`Bun ${Bun.version} cannot send a WebSocket through a proxy`)
    expect(error.message).toContain("chatgpt.com")
  })
})

describe("ModelsTransportLive refuses an unusable proxy", () => {
  test("a SOCKS proxy fails the layer with ProxyInvalid, credentials unrepeated", async () => {
    const exit = await Effect.runPromise(Effect.exit(Effect.scoped(Effect.service(ModelsTransport).pipe(
      Effect.provide(ModelsTransportLive({})),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { HTTPS_PROXY: "socks5://user:secret@proxy:1080" } })),
    ))))
    const error = Option.getOrThrow(Exit.findErrorOption(exit))
    expect(error).toBeInstanceOf(ProxyInvalid)
    expect(error.message).toContain("HTTPS_PROXY is a socks5:// proxy")
    expect(error.message).not.toContain("secret")
  })
})
