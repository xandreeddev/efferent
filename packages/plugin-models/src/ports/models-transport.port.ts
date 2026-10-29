import { Context } from "effect"
import type { Effect, Option, Redacted } from "effect"
import type { Agent } from "node:http"
import type { ProxyUnsupported } from "../transport/http-proxy.entity.js"

/**
 * A fetch for the models plugin's HTTP calls: a URL (string or `URL`) and a
 * `RequestInit`, as the provider clients, the OpenAI-compatible client and
 * the OAuth token requests call it. Any `fetch` is one.
 */
export type ModelsFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/**
 * How a WebSocket reaches its target. `Agent` is for Node only: the agent
 * the `ws` client connects with (one that tunnels through the proxy with
 * CONNECT, or a plain one for a direct connection). `Proxy` is for Bun only:
 * the proxy URL Bun's own `WebSocket` takes as its `proxy` option. A route
 * the runtime cannot use (`Proxy` outside Bun, `Agent` on Bun, whose `ws`
 * stand-in takes neither) fails the call rather than connecting past the
 * proxy.
 */
export type WebSocketProxy =
  | { readonly _tag: "Agent"; readonly agent: Agent }
  | { readonly _tag: "Proxy"; readonly url: Redacted.Redacted<string> }

/**
 * The network path of the models plugin: every HTTP call it makes (the
 * provider SDKs, the OpenAI-compatible client, OAuth token requests) goes
 * through `fetch`, and the OpenAI subscription's WebSocket asks
 * `webSocketAgent` how to reach its target: `None` connects the runtime's
 * default way (direct, unless the runtime applies an environment proxy
 * itself, as Node's global agents do under `NODE_USE_ENV_PROXY`),
 * `ProxyUnsupported` refuses (a proxy applies that this runtime cannot
 * tunnel a WebSocket through). Without `webSocketAgent`, WebSockets connect
 * the default way. `ModelsTransportLive` builds one from a proxy setting and
 * the environment; a host provides its own (a fetch with client
 * certificates, say) through `Agent.define({ services })`.
 */
export class ModelsTransport extends Context.Service<ModelsTransport, {
  readonly fetch: ModelsFetch
  readonly webSocketAgent?: (target: URL) => Effect.Effect<Option.Option<WebSocketProxy>, ProxyUnsupported>
}>()("@xandreed/plugin-models/ModelsTransport") {}
