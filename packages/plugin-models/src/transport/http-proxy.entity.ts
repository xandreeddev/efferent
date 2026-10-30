import { Schema } from "effect"

/**
 * A proxy URL as an option takes it: a string, or a `Redacted` one when it carries credentials.
 *
 * @public
 */
export const ProxyUrlOption = Schema.Union([
  Schema.String,
  Schema.Redacted(Schema.String).annotate({ message: "proxy is a URL string or a Redacted one" }),
]).annotate({ message: "proxy is a URL string or a Redacted one" })
export type ProxyUrlOption = typeof ProxyUrlOption.Type

/**
 * The proxy a host gives the models plugin, as its `proxy` and `noProxy`
 * options. `proxy` is one URL for every model and OAuth call (`http://` or
 * `https://`; a value without a scheme reads as `http://`); it may carry
 * credentials (`http://user:pass@proxy:8080`), so a host's code can pass it
 * `Redacted`. Empty or absent, the environment's `https_proxy` /
 * `HTTPS_PROXY` and `http_proxy` / `HTTP_PROXY` apply. `noProxy` lists the
 * hosts that go direct, in NO_PROXY syntax, added to the environment's
 * `no_proxy` / `NO_PROXY`; `"*"` turns the proxy off.
 *
 * @public
 */
export const HttpProxyOptions = Schema.Struct({
  proxy: Schema.optionalKey(ProxyUrlOption),
  noProxy: Schema.optionalKey(Schema.String),
})
export type HttpProxyOptions = typeof HttpProxyOptions.Type

/**
 * The proxy variables of the environment, as read (an empty value counts as
 * unset). Lower case is read before upper case, as undici (Node's
 * environment proxy) and curl read them. `ALL_PROXY` is not read: SOCKS
 * proxies are not supported.
 */
export const ProxyEnvironment = Schema.Struct({
  https_proxy: Schema.optionalKey(Schema.String),
  HTTPS_PROXY: Schema.optionalKey(Schema.String),
  http_proxy: Schema.optionalKey(Schema.String),
  HTTP_PROXY: Schema.optionalKey(Schema.String),
  no_proxy: Schema.optionalKey(Schema.String),
  NO_PROXY: Schema.optionalKey(Schema.String),
})
export type ProxyEnvironment = typeof ProxyEnvironment.Type

/** The environment variables a `ProxyEnvironment` is read from. */
export const PROXY_VARIABLES = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "no_proxy", "NO_PROXY"] as const

/**
 * One NO_PROXY entry: every host (`*`); a host name and its subdomains
 * (`example.com`, `.example.com` and `*.example.com` alike); or an IP
 * address, exact (`10.1.2.3`, `::1`, `[::1]`) or a range (`10.0.0.0/8`,
 * `fd00::/8`, as `prefix` leading bits). A name or an exact address may
 * carry a port (`example.com:8443`, `[::1]:8080`), which then must match.
 */
export const NoProxyRule = Schema.Union([
  Schema.TaggedStruct("Everything", {}),
  Schema.TaggedStruct("Domain", { name: Schema.String, port: Schema.Option(Schema.Int) }),
  Schema.TaggedStruct("Address", {
    bytes: Schema.Array(Schema.Int),
    prefix: Schema.Int,
    port: Schema.Option(Schema.Int),
  }),
])
export type NoProxyRule = typeof NoProxyRule.Type

/**
 * A resolved proxy setting: the proxy for `https:` (and `wss:`) targets,
 * the one for `http:` (and `ws:`) targets, and the hosts that go direct.
 * Proxy URLs stay `Redacted`, so a printed setting never shows credentials.
 * Loopback hosts always go direct.
 */
export class ProxyConfig extends Schema.Class<ProxyConfig>("ProxyConfig")({
  https: Schema.Option(Schema.Redacted(Schema.String)),
  http: Schema.Option(Schema.Redacted(Schema.String)),
  noProxy: Schema.Array(NoProxyRule),
}) {}

/**
 * A proxy URL that cannot be used: not a URL, or not `http://` / `https://`. `source` names where it came from.
 *
 * @public
 */
export class ProxyInvalid extends Schema.TaggedError<ProxyInvalid>()("ProxyInvalid", {
  source: Schema.String,
  message: Schema.String,
}) {}

/**
 * A proxy applies, but this runtime cannot send the call through it: the call is refused rather than sent direct.
 *
 * @public
 */
export class ProxyUnsupported extends Schema.TaggedError<ProxyUnsupported>()("ProxyUnsupported", {
  message: Schema.String,
}) {}

/** The first Bun whose native `WebSocket` sends through its `proxy` option (1.3.0 to 1.3.5 connect directly). */
export const BUN_WEBSOCKET_PROXY_VERSION = "1.3.6"

/** The first Node whose `https.Agent` tunnels through its `proxyEnv` option (earlier ones connect directly). */
export const NODE_WEBSOCKET_PROXY_VERSION = "24.5.0"
