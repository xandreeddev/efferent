import { Agent as HttpAgent } from "node:http"
import { Agent as HttpsAgent } from "node:https"
import { Config, Effect, Layer, Match, Option, Redacted } from "effect"
import type { Context, Scope } from "effect"
import type { Agent, Dispatcher, ProxyAgent, buildConnector } from "undici"
import { ModelsTransport } from "../ports/models-transport.port.js"
import type { ModelsFetch, WebSocketProxy } from "../ports/models-transport.port.js"
import { BUN_WEBSOCKET_PROXY_VERSION, NODE_WEBSOCKET_PROXY_VERSION, PROXY_VARIABLES, ProxyUnsupported } from "./http-proxy.entity.js"
import type { HttpProxyOptions, ProxyConfig, ProxyEnvironment, ProxyInvalid } from "./http-proxy.entity.js"
import { atLeastVersion, displayProxy, proxyFor, redactCredentials, resolveProxy, turnsProxyOff, usesProxy } from "./http-proxy.entity.functions.js"
import { undiciFetch } from "./undici-fetch.adapter.js"

/** The runtime the plugin runs on, told apart without a Bun-only import (the subscription's WebSocket checks its route against it too). */
export type Runtime =
  | { readonly _tag: "Bun"; readonly version: string }
  | { readonly _tag: "Node"; readonly version: string }
  | { readonly _tag: "Other" }

export const currentRuntime = (): Runtime => {
  const versions: Readonly<Record<string, string | undefined>> = typeof process === "undefined" ? {} : process.versions
  const bun = versions["bun"]
  const node = versions["node"]
  return bun !== undefined ? { _tag: "Bun", version: bun } : node !== undefined ? { _tag: "Node", version: node } : { _tag: "Other" }
}

/** The proxy variables of the environment, read through `Config` (a test swaps the `ConfigProvider`). */
const readEnvironment: Effect.Effect<ProxyEnvironment, Config.ConfigError> = Effect.forEach(PROXY_VARIABLES, (name) =>
  Config.option(Config.String(name)).pipe(Effect.map((value) => Option.toArray(Option.map(value, (text) => [name, text] as const)))), { concurrency: 1 }).pipe(
  Effect.map((entries): ProxyEnvironment => Object.fromEntries(entries.flat())),
)

/** The URL a request goes to, when it parses. */
const targetOf = (input: string | URL): Option.Option<URL> =>
  typeof input === "string" ? (URL.canParse(input) ? Option.some(new URL(input)) : Option.none()) : Option.some(input)

/** Whether a target speaks TLS, so it takes the https proxy. */
const isSecure = (target: URL): boolean => target.protocol === "https:" || target.protocol === "wss:"

/** What a failed request's error says, with its cause's, credentials redacted. */
const describeFailure = (cause: unknown): string => {
  const own = cause instanceof Error ? cause.message : String(cause)
  const inner = cause instanceof Error && cause.cause !== undefined
    ? cause.cause instanceof Error ? cause.cause.message : String(cause.cause)
    : ""
  return redactCredentials(inner.length > 0 && inner !== own ? `${own}: ${inner}` : own)
}

/**
 * A proxied request's failure, made to name the proxy (without its
 * credentials) and the target: "fetch failed" alone does not say a proxy
 * was in the way. A cancellation passes through as it is.
 */
const throughProxy = (target: URL, proxy: Redacted.Redacted<string>, request: Promise<Response>): Promise<Response> =>
  request.then((response) => response, (cause: unknown) => Promise.reject(
    cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")
      ? cause
      : new TypeError(`the request to ${target.protocol}//${target.host} through the proxy ${displayProxy(proxy)} failed: ${describeFailure(cause)}`, { cause }),
  ))

/** No proxy anywhere: every call is the global fetch, read per call, and WebSockets connect directly. */
const directTransport = ModelsTransport.of({ fetch: (input, init) => globalThis.fetch(input, init) })

/** Why a WebSocket that a proxy applies to is refused. */
const webSocketRefused = (target: URL, why: string) => new ProxyUnsupported({
  message: `${why}, so the WebSocket to ${target.host} is refused instead of connecting directly past the proxy`,
})

/**
 * A proxied response on Bun. Bun hands back a proxy's own answer to the
 * CONNECT (or to an absolute-form request) as if the target had sent it; a
 * 407 (Proxy Authentication Required) can only be the proxy's, so it fails
 * the request, which `throughProxy` then names the proxy in. A proxy's other
 * refusals (a 403, say) cannot be told from the provider's own and pass as
 * they are.
 */
const refuseProxyAuthentication = (response: Response): Promise<Response> =>
  response.status === 407
    ? (response.body === null ? Promise.resolve() : response.body.cancel().then(() => undefined, () => undefined)).then(() =>
      Promise.reject(new Error("the proxy refused its credentials (407 Proxy Authentication Required)")))
    : Promise.resolve(response)

/**
 * Bun: fetch's own `proxy` option, per request (`http:` targets go to the
 * proxy in absolute form, `https:` ones through a CONNECT tunnel), and the
 * native `WebSocket`'s `proxy` option from Bun 1.3.6 on. Bun applies
 * `HTTPS_PROXY` / `HTTP_PROXY` from the environment to every fetch itself
 * (honouring the environment's `NO_PROXY`), so a host the `noProxy` option
 * or the loopback rule exempts still goes through an environment proxy.
 */
const bunTransport = (config: ProxyConfig, version: string) => ModelsTransport.of({
  fetch: (input, init) => Option.match(Option.flatMap(targetOf(input), (target) => Option.map(proxyFor(target, config), (proxy) => [target, proxy] as const)), {
    onNone: () => globalThis.fetch(input, init),
    onSome: ([target, proxy]) => throughProxy(target, proxy, globalThis.fetch(input, { ...init, proxy: Redacted.value(proxy) }).then(refuseProxyAuthentication)),
  }),
  webSocketAgent: (target) => Option.match(proxyFor(target, config), {
    onNone: () => Effect.succeedNone,
    onSome: (url) => atLeastVersion(version, BUN_WEBSOCKET_PROXY_VERSION)
      ? Effect.succeedSome<WebSocketProxy>({ _tag: "Proxy", url })
      : Effect.fail(webSocketRefused(target, `Bun ${version} cannot send a WebSocket through a proxy (Bun ${BUN_WEBSOCKET_PROXY_VERSION} and later can)`)),
  }),
})

/** A Client option `connect` that is a connector function. */
const isConnector = (value: unknown): value is buildConnector.connector => typeof value === "function"

/** The `code` an error carries, if any. */
const codeOf = (error: Error): unknown => "code" in error ? error.code : undefined

/**
 * A tunnel connector that fails once when the proxy closes the connection
 * while the tunnel is opened. undici takes that as a recoverable socket error
 * and opens the tunnel again at once, thousands of times a second, until the
 * request's own timeout; failing it ends the request with the proxy named.
 */
const tunnelOnce = (connect: buildConnector.connector, proxy: Redacted.Redacted<string>): buildConnector.connector =>
  (options, callback) => connect(options, (...result) => {
    const [error] = result
    return error !== null && codeOf(error) === "UND_ERR_SOCKET"
      ? callback(new Error(`the proxy ${displayProxy(proxy)} closed the connection while opening a tunnel to ${options.hostname}:${options.port.length > 0 ? options.port : options.protocol === "https:" ? "443" : "80"} (${error.message})`, { cause: error }), null)
      : callback(...result)
  })

/** The undici the Node transport uses, loaded only when the transport is built on Node. */
type Undici = typeof import("undici")

const loadUndici: Effect.Effect<Undici, ProxyUnsupported> = Effect.tryPromise({
  try: () => import("undici"),
  catch: (cause) => new ProxyUnsupported({ message: `undici, which sends the models plugin's calls on Node under a proxy setting, could not be loaded: ${describeFailure(cause)}` }),
})

/**
 * Node's direct route: undici's `fetch` over its own `Agent`, and a plain
 * `https.Agent` (`http.Agent` for `ws:`) for WebSockets, so a direct call
 * takes neither Node's global dispatcher nor its global agents, which
 * `NODE_USE_ENV_PROXY` points at the environment's proxy. They close with
 * the layer's scope.
 */
/** Close a dispatcher as its scope closes: one that fails to is logged, and the rest still close. */
const destroyDispatcher = (dispatcher: { readonly destroy: () => Promise<void> }): Effect.Effect<void> =>
  Effect.tryPromise({ try: () => dispatcher.destroy(), catch: (cause) => cause }).pipe(
    Effect.catch((cause) => Effect.logDebug("models transport: a connection pool did not close", cause)),
  )

const nodeDirect = (undici: Undici) => Effect.gen(function* () {
  const dispatcher: Agent = new undici.Agent()
  const sockets = { https: new HttpsAgent(), http: new HttpAgent() }
  yield* Effect.addFinalizer(() => Effect.all([
    destroyDispatcher(dispatcher),
    Effect.sync(() => [sockets.https, sockets.http].forEach((agent) => agent.destroy())),
  ], { concurrency: 1, discard: true }))
  return {
    fetch: undiciFetch(undici.fetch, dispatcher),
    webSocket: (target: URL): WebSocketProxy => ({ _tag: "Agent", agent: isSecure(target) ? sockets.https : sockets.http }),
  }
})

/**
 * Node with the proxy turned off (`*` in `noProxy` or `NO_PROXY`): every
 * call on the direct route, so it stays direct even where Node's own fetch
 * would apply the environment's proxy (`NODE_USE_ENV_PROXY`).
 */
const nodeDirectTransport = Effect.gen(function* () {
  const direct = yield* nodeDirect(yield* loadUndici)
  return ModelsTransport.of({ fetch: direct.fetch, webSocketAgent: (target) => Effect.succeedSome(direct.webSocket(target)) })
})

/**
 * Node: undici's `fetch` with a `ProxyAgent` per proxy URL (a CONNECT tunnel
 * for every target) and the direct route for the hosts that go direct, so
 * neither depends on Node's global dispatcher or agents, which
 * `NODE_USE_ENV_PROXY` would make proxy them. WebSockets tunnel through an
 * `https.Agent` (`http.Agent` for `ws:`) with `proxyEnv`, which Node
 * honours from 24.5. The agents close with the layer's scope.
 */
const nodeTransport = (config: ProxyConfig, version: string) => Effect.gen(function* () {
  const undici = yield* loadUndici
  const direct = yield* nodeDirect(undici)
  const proxyAgent = (proxy: Redacted.Redacted<string>): ProxyAgent => new undici.ProxyAgent({
    uri: Redacted.value(proxy),
    factory: (origin, options) => {
      const connect: unknown = Reflect.get(options, "connect")
      return new undici.Pool(origin, { ...options, ...(isConnector(connect) ? { connect: tunnelOnce(connect, proxy) } : {}) })
    },
  })
  const sameUrl = Option.isSome(config.https) && Option.isSome(config.http) && Redacted.value(config.https.value) === Redacted.value(config.http.value)
  const route = (proxy: Redacted.Redacted<string>) => {
    const dispatcher = proxyAgent(proxy)
    return { proxy, dispatcher, fetch: undiciFetch(undici.fetch, dispatcher) }
  }
  const httpsRoute = Option.map(config.https, route)
  const httpRoute = sameUrl ? httpsRoute : Option.map(config.http, route)
  const socketAgents = {
    https: Option.map(config.https, (proxy) => new HttpsAgent({ proxyEnv: { HTTPS_PROXY: Redacted.value(proxy) } })),
    http: Option.map(config.http, (proxy) => new HttpAgent({ proxyEnv: { HTTP_PROXY: Redacted.value(proxy) } })),
  }
  const dispatchers: ReadonlyArray<Dispatcher> = [...Option.toArray(Option.map(httpsRoute, (route) => route.dispatcher)), ...(sameUrl ? [] : Option.toArray(Option.map(httpRoute, (route) => route.dispatcher)))]
  yield* Effect.addFinalizer(() => Effect.all([
    Effect.forEach(dispatchers, destroyDispatcher, { concurrency: 1, discard: true }),
    Effect.sync(() => [...Option.toArray(socketAgents.https), ...Option.toArray(socketAgents.http)].forEach((agent) => agent.destroy())),
  ], { concurrency: 1, discard: true }))
  const routeFor = (target: URL) => Option.flatMap(proxyFor(target, config), () => isSecure(target) ? httpsRoute : httpRoute)
  const fetch: ModelsFetch = (input, init) => Option.match(Option.flatMap(targetOf(input), (target) => Option.map(routeFor(target), (route) => [target, route] as const)), {
    onNone: () => direct.fetch(input, init),
    onSome: ([target, route]) => throughProxy(target, route.proxy, route.fetch(input, init)),
  })
  return ModelsTransport.of({
    fetch,
    webSocketAgent: (target) => Option.match(Option.flatMap(proxyFor(target, config), () => isSecure(target) ? socketAgents.https : socketAgents.http), {
      onNone: () => Effect.succeedSome(direct.webSocket(target)),
      onSome: (agent) => atLeastVersion(version, NODE_WEBSOCKET_PROXY_VERSION)
        ? Effect.succeedSome<WebSocketProxy>({ _tag: "Agent", agent })
        : Effect.fail(webSocketRefused(target, `Node ${version} ignores the proxyEnv option of https.Agent (Node ${NODE_WEBSOCKET_PROXY_VERSION} and later honour it)`)),
    }),
  })
})

/**
 * The transport a proxy setting calls for, or `None` when no proxy applies
 * and nothing has to be held direct: then the plugin adds no transport and
 * every call uses the runtime's own fetch, as it did before the plugin knew
 * proxies (a `FetchHttpClient.Fetch` the host provides still reaches the
 * provider SDKs). With the proxy turned off (`*`) on Node it is a transport
 * over undici's direct agent, since Node's global fetch and agents apply the
 * environment's proxy under `NODE_USE_ENV_PROXY`. A proxy URL that cannot
 * be used fails with `ProxyInvalid`; a runtime that is neither Node nor Bun
 * fails with `ProxyUnsupported` when a proxy applies. Its connection pools
 * close with the scope.
 */
export const modelsTransportFor = (options: HttpProxyOptions): Effect.Effect<Option.Option<Context.Service.Shape<typeof ModelsTransport>>, ProxyInvalid | ProxyUnsupported | Config.ConfigError, Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* Effect.fromResult(resolveProxy(options, yield* readEnvironment))
    const runtime = currentRuntime()
    if (!usesProxy(config)) {
      return yield* Match.value(runtime).pipe(
        Match.tag("Node", () => turnsProxyOff(config) ? Effect.map(nodeDirectTransport, Option.some) : Effect.succeedNone),
        Match.orElse(() => Effect.succeedNone),
      )
    }
    return Option.some(yield* Match.value(runtime).pipe(
      Match.tag("Bun", ({ version }) => Effect.succeed(bunTransport(config, version))),
      Match.tag("Node", ({ version }) => nodeTransport(config, version)),
      Match.tag("Other", () => Effect.fail(new ProxyUnsupported({
        message: "a proxy is configured, but this runtime is neither Node nor Bun: the models plugin cannot send its calls through a proxy here",
      }))),
      Match.exhaustive,
    ))
  })

/**
 * `ModelsTransportLive(options)` — the models plugin's network path from a
 * proxy setting: `options.proxy` (or `https_proxy` / `HTTPS_PROXY` and
 * `http_proxy` / `HTTP_PROXY` from the environment) for every call, except
 * loopback hosts and the `noProxy` / `NO_PROXY` hosts, which go direct (see
 * `resolveProxy`). With no proxy at all it is the global fetch, unchanged;
 * with `noProxy: "*"` on Node, undici's direct agent. A proxy URL that cannot
 * be used fails with `ProxyInvalid`; a runtime that is neither Node nor Bun
 * fails with `ProxyUnsupported` when a proxy applies. Its connection pools
 * close with the layer's scope. Hosts use it for the OAuth login helpers too:
 * `exchangeAnthropicCode(code, verifier, { fetch: transport.fetch })`.
 */
export const ModelsTransportLive = (options: HttpProxyOptions = {}): Layer.Layer<ModelsTransport, ProxyInvalid | ProxyUnsupported | Config.ConfigError> =>
  Layer.effect(ModelsTransport, Effect.map(modelsTransportFor(options), Option.getOrElse(() => directTransport)))

/**
 * A transport's fetch as `FetchHttpClient.Fetch` takes it (the type of the
 * global `fetch`): a `Request` input is sent as its URL, method, headers,
 * body and signal; Bun's `fetch.preconnect` does nothing.
 */
export const transportFetch = (transport: Context.Service.Shape<typeof ModelsTransport>): typeof globalThis.fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => input instanceof Request
      ? input.arrayBuffer().then((body) => transport.fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: body.byteLength === 0 ? null : body,
        signal: input.signal,
        ...init,
      }))
      : transport.fetch(input, init),
    { preconnect: (): void => undefined },
  )
