// The models plugin's proxy transport on Node, against the packed packages
// (scripts/verify-packages.ts). It runs with NODE_USE_ENV_PROXY=1 and
// HTTP_PROXY / HTTPS_PROXY pointing at a port nothing listens on, so Node's
// own fetch would send every request to that dead proxy: the transport must
// use undici with its own agents, through the recording proxy below for
// proxied hosts and directly for loopback and noProxy hosts.
import { createServer, request as httpRequest } from "node:http"
import { connect, createServer as createTcpServer } from "node:net"
import { ConfigProvider, Context, Effect, Option } from "effect"
import { LanguageModel } from "effect/ai"
import { HttpClientRequest } from "effect/http"
import { SessionEnvironment, UtilityLlm } from "@xandreed/core"
import { makeOpenAiCodexWebSocketHttpClient, ModelsTransport, ModelsTransportLive, modelsPlugin } from "@xandreed/plugin-models"

const fail = (message) => { console.error(`proxy consumer: ${message}`); process.exit(1) }
// @xandreed/plugin-models needs Node 24.5: older Node ignores the proxyEnv option the subscription's WebSocket tunnels with.
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number)
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 5)) fail(`@xandreed/plugin-models requires Node 24.5 or newer; this is Node ${process.versions.node}`)
if (process.env.NODE_USE_ENV_PROXY !== "1" || process.env.HTTP_PROXY === undefined) fail("run with NODE_USE_ENV_PROXY=1 and a dead HTTP_PROXY")

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))

// A chat-completions endpoint on 127.0.0.1.
const chat = createServer((request, response) => {
  const chunks = []
  request.on("data", (chunk) => chunks.push(chunk))
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: `answered ${body.model}` } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
})
const chatPort = await listen(chat)

// A recording proxy over raw sockets: CONNECT tunnels and absolute-form requests to *.invalid hosts reach
// 127.0.0.1; every other host is refused with 403, so nothing here reaches the network.
const startProxy = async ({ reset = false } = {}) => {
  const seen = []
  const clients = []
  const server = createTcpServer((client) => {
    seen.push({ kind: "connection" })
    if (reset) return client.destroy()
    clients.push(client)
    const pending = []
    const onData = (chunk) => {
      pending.push(chunk)
      const all = Buffer.concat(pending)
      const end = all.indexOf("\r\n\r\n")
      if (end < 0) return
      client.off("data", onData)
      const [line, ...headers] = all.subarray(0, end).toString("latin1").split("\r\n")
      const rest = all.subarray(end + 4)
      const [method, target] = line.split(" ")
      const authorization = headers.find((header) => /^proxy-authorization:/i.test(header))?.replace(/^[^:]*:\s*/, "") ?? null
      const splice = (upstream) => { upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy()); upstream.pipe(client); client.pipe(upstream) }
      if (method === "CONNECT") {
        seen.push({ kind: "connect", target, authorization })
        const at = target.lastIndexOf(":")
        if (!target.slice(0, at).endsWith(".invalid")) return client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n")
        const upstream = connect(Number(target.slice(at + 1)), "127.0.0.1", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); upstream.write(rest); splice(upstream) })
        return upstream.on("error", () => client.destroy())
      }
      seen.push({ kind: "absolute", target, authorization })
      const url = new URL(target)
      if (!url.hostname.endsWith(".invalid")) return client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
      const kept = headers.filter((header) => !/^(proxy-[^:]*|connection|keep-alive):/i.test(header))
      const upstream = connect(Number(url.port || 80), "127.0.0.1", () => {
        upstream.write([`${method} ${url.pathname}${url.search} HTTP/1.1`, ...kept, "connection: close", "", ""].join("\r\n"))
        upstream.write(rest)
        splice(upstream)
      })
      return upstream.on("error", () => client.destroy())
    }
    client.on("data", onData)
    client.on("error", () => client.destroy())
  })
  const port = await listen(server)
  return { url: `http://127.0.0.1:${port}`, port, seen, requests: () => seen.filter((entry) => entry.kind !== "connection"), close: () => { clients.forEach((client) => client.destroy()); server.close() } }
}

const proxy = await startProxy()
const deadPort = Number(new URL(process.env.HTTP_PROXY).port)
const proxiedEndpoint = `http://models.proxy-test.invalid:${chatPort}/v1`
const failureOf = (promise) => promise.then(() => null, (error) => error)

// 1. Node's own fetch is captured by the dead environment proxy: the situation the transport must not depend on.
const nodeOwn = await failureOf(fetch(`http://models.proxy-test.invalid:${chatPort}/`))
if (nodeOwn?.cause?.code !== "ECONNREFUSED" || !String(nodeOwn.cause.message).includes(String(deadPort))) fail(`Node's own fetch did not go to the dead environment proxy: ${nodeOwn?.cause?.message}`)

// 2. The models plugin: a model call and a utility call through the proxy option, a loopback endpoint direct.
const replies = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const services = yield* modelsPlugin.build({
    ...modelsPlugin.defaults, storage: "memory", model: "stub:general", fastModel: "local:fast", proxy: proxy.url,
    endpoints: { stub: { url: proxiedEndpoint }, local: { url: `http://127.0.0.1:${chatPort}/v1` } },
  }, Context.make(SessionEnvironment, { workspace: process.cwd() }))
  const general = yield* Context.getUnsafe(services, LanguageModel.LanguageModel).generateText({ prompt: "hi" })
  const fast = yield* Context.getUnsafe(services, UtilityLlm).complete("a title")
  return [general.text, fast.text]
})))
if (JSON.stringify(replies) !== JSON.stringify(["answered general", "answered fast"])) fail(`replies ${JSON.stringify(replies)}`)
// undici tunnels an http: target too (CONNECT); the loopback endpoint never reached the proxy.
if (JSON.stringify(proxy.requests()) !== JSON.stringify([{ kind: "connect", target: `models.proxy-test.invalid:${chatPort}`, authorization: null }])) fail(`the proxy saw ${JSON.stringify(proxy.requests())}`)

// The transport alone, provided around its whole use (its agents close with the layer), under the given environment.
const withTransport = (options, env, use) => Effect.runPromise(Effect.gen(function* () {
  const transport = yield* Effect.service(ModelsTransport)
  return yield* Effect.promise(() => use(transport))
}).pipe(Effect.provide(ModelsTransportLive(options)), Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }))))

// 3. A noProxy host goes direct through undici's own agent, not the dead environment proxy: it does not resolve.
proxy.seen.length = 0
const direct = await withTransport({ proxy: proxy.url, noProxy: "direct.proxy-test.invalid" }, {}, (transport) => failureOf(transport.fetch(`http://direct.proxy-test.invalid:${chatPort}/v1/chat/completions`)))
if (direct?.cause?.code !== "ENOTFOUND" || proxy.seen.length > 0) fail(`a noProxy host did not go direct: ${direct?.cause?.code} ${direct?.message}`)

// 4. HTTP_PROXY from the environment (read through Config) applies on Node: credentials reach the proxy.
const credentialed = `http://user:pa%40ss@127.0.0.1:${proxy.port}`
const viaEnv = await withTransport({}, { HTTP_PROXY: credentialed }, (transport) => transport.fetch(`${proxiedEndpoint}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "env" }) }).then((response) => response.json()))
if (viaEnv.choices?.[0]?.message?.content !== "answered env") fail(`through HTTP_PROXY: ${JSON.stringify(viaEnv)}`)
if (proxy.requests().at(-1)?.authorization !== `Basic ${Buffer.from("user:pa@ss").toString("base64")}`) fail(`the proxy credentials did not arrive: ${JSON.stringify(proxy.requests())}`)

// 5. A proxy that is not there: a clear error naming the target and the proxy, its credentials redacted.
const dead = await withTransport({ proxy: `http://user:secret@127.0.0.1:${deadPort}` }, {}, (transport) => failureOf(transport.fetch(`${proxiedEndpoint}/chat/completions`)))
if (!String(dead?.message).includes(`the request to http://models.proxy-test.invalid:${chatPort} through the proxy http://<redacted>@127.0.0.1:${deadPort} failed`) || String(dead?.message).includes("secret")) fail(`dead proxy: ${dead?.message}`)

// 6. A proxy that resets every connection fails the request at once (undici alone would reopen the tunnel in a tight loop).
const resetting = await startProxy({ reset: true })
const started = Date.now()
const reset = await withTransport({ proxy: resetting.url }, {}, (transport) => failureOf(transport.fetch("https://api.anthropic.com/v1/messages", { signal: AbortSignal.timeout(10_000) })))
const resetConnections = resetting.seen.length
resetting.close()
if (!String(reset?.message).includes("closed the connection while opening a tunnel to api.anthropic.com:443") || Date.now() - started > 5_000 || resetConnections > 5) {
  fail(`resetting proxy: ${reset?.message} after ${Date.now() - started} ms and ${resetConnections} connections`)
}

// A chat request over a WebSocket route's agent: a direct agent reaches the loopback endpoint, past Node's global
// agents, which NODE_USE_ENV_PROXY points at the dead environment proxy.
const postWith = (agent, model) => new Promise((resolve) => {
  const outgoing = httpRequest({ host: "127.0.0.1", port: chatPort, method: "POST", path: "/v1/chat/completions", agent, headers: { "content-type": "application/json" } }, (response) => {
    const chunks = []
    response.on("data", (chunk) => chunks.push(chunk))
    response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")).choices?.[0]?.message?.content))
  })
  outgoing.on("error", (error) => resolve(`failed: ${error.code ?? error.message}`))
  outgoing.end(JSON.stringify({ model }))
})
const isDirectAgent = (route) => Option.isSome(route) && route.value._tag === "Agent" && route.value.agent.options.proxyEnv === undefined

// 7. The OpenAI subscription's WebSocket sends its CONNECT through the proxy with the agent the transport gives; a
// loopback WebSocket gets a direct agent. (The test proxy refuses chatgpt.com, so no TLS handshake follows the CONNECT.)
proxy.seen.length = 0
const socket = await withTransport({ proxy: proxy.url }, {}, (transport) => Effect.runPromise(Effect.gen(function* () {
  const route = yield* transport.webSocketAgent(new URL("wss://chatgpt.com/backend-api/codex/responses"))
  if (Option.isNone(route) || route.value._tag !== "Agent") return yield* Effect.die(`no agent for the WebSocket: ${JSON.stringify(route)}`)
  const loopback = yield* transport.webSocketAgent(new URL("ws://127.0.0.1:9/socket"))
  if (!isDirectAgent(loopback)) return yield* Effect.die("a loopback WebSocket would not connect directly")
  const reply = yield* Effect.promise(() => postWith(loopback.value.agent, "socket"))
  if (reply !== "answered socket") return yield* Effect.die(`the direct WebSocket agent did not reach the loopback endpoint: ${reply}`)
  const request = HttpClientRequest.post("https://chatgpt.com/backend-api/codex/responses").pipe(HttpClientRequest.bodyJsonUnsafe({ model: "gpt-test" }))
  return yield* Effect.flip(Effect.scoped(makeOpenAiCodexWebSocketHttpClient(route).execute(request)))
})))
if (JSON.stringify(proxy.requests()) !== JSON.stringify([{ kind: "connect", target: "chatgpt.com:443", authorization: null }])) fail(`the WebSocket did not tunnel: ${JSON.stringify(proxy.requests())} (${String(socket)})`)

// 8. noProxy "*" keeps every call direct, though Node's own fetch and agents would take the dead environment proxy:
// the plugin (reading HTTP_PROXY / HTTPS_PROXY from this process's environment) reaches the loopback endpoint.
proxy.seen.length = 0
const off = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const services = yield* modelsPlugin.build({
    ...modelsPlugin.defaults, storage: "memory", model: "local:off", noProxy: "*",
    endpoints: { local: { url: `http://127.0.0.1:${chatPort}/v1` } },
  }, Context.make(SessionEnvironment, { workspace: process.cwd() }))
  return (yield* Context.getUnsafe(services, LanguageModel.LanguageModel).generateText({ prompt: "hi" })).text
})).pipe(Effect.timeout("20 seconds")))
if (off !== "answered off" || proxy.seen.length > 0) fail(`with noProxy "*" a call did not go direct: ${off}`)
const offSocket = await withTransport({ noProxy: "*" }, { HTTPS_PROXY: process.env.HTTPS_PROXY ?? "" }, (transport) => Effect.runPromise(transport.webSocketAgent(new URL("wss://chatgpt.com/backend-api/codex/responses"))))
if (!isDirectAgent(offSocket)) fail(`with noProxy "*" the subscription's WebSocket would not connect directly: ${JSON.stringify(offSocket)}`)

proxy.close()
chat.close()
console.log("On Node with NODE_USE_ENV_PROXY and a dead environment proxy, the models plugin's transport sent model and utility calls through its proxy option (CONNECT), loopback and noProxy hosts direct, honoured HTTP_PROXY with credentials, named a dead proxy without its credentials, failed fast on a resetting proxy, sent the subscription WebSocket's CONNECT through the proxy, and kept every call direct with noProxy \"*\"")
process.exit(0)
