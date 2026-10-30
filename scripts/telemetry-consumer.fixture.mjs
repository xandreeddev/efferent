// The telemetry plugin and its OTLP export through the packed packages
// (scripts/verify-packages.ts runs this on Node, then on Bun): a turn with
// `telemetryPlugin`, under `OtlpTelemetryLive` exporting to a node:http
// collector on a free port with an hour's interval. Nothing is posted
// before `flushTelemetry`; after it, while the export layer is still open
// (a serverless host responds then), the turn's `agent.turn` span (with
// its ids), the step loop's `engine.run` under it, and the usage metric by
// kind (cache writes included) and the cost must have arrived.
import { createServer } from "node:http"
import { Context, Effect, Layer, Option, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { costOf, ENGINE_KEY, Sessions, SessionLogMemoryLive, TurnAdmissionOpen, UserMessage, usageBreakdown } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"
import { flushTelemetry, OtlpTelemetryLive, telemetryPlugin } from "@xandreed/plugin-telemetry"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"

const runtime = typeof Bun === "undefined" ? `Node ${process.versions.node}` : `Bun ${Bun.version}`
const fail = (message) => { console.error(`telemetry consumer (${runtime}): ${message}`); process.exit(1) }

// An OTLP/HTTP collector keeping every post.
const posts = []
const server = createServer((request, response) => {
  const chunks = []
  request.on("data", (chunk) => chunks.push(chunk))
  request.on("end", () => {
    posts.push({ path: request.url, contentType: request.headers["content-type"] ?? "", body: Buffer.concat(chunks).toString("utf8") })
    response.setHeader("content-type", "application/json")
    response.end("{}")
  })
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`

const model = "scripted:consumer"
const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
const usage = { inputTokens: { total: 100, uncached: 60, cacheRead: 30, cacheWrite: 10 }, outputTokens: { total: 20, reasoning: 5 } }

const { result, session, unflushed, flushed } = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsPluginLive({ ownership: { mode: "process" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: telemetryPlugin, options: { prices: { [model]: price } } }],
    turnServices: [LanguageModel.LanguageModel],
    limits: { streaming: false, maxSteps: 2 },
    system: "Be brief.",
  })
  // The models plugin stamps its selection on the finish part; the scripted model does the same.
  const llm = yield* LanguageModel.make({
    generateText: () => Effect.succeed([{ type: "text", text: "hello" }, { type: "finish", reason: "stop", usage, metadata: { [ENGINE_KEY]: { model } } }]),
    streamText: () => Stream.die("not scripted"),
  })
  const view = yield* sessions.create({ owner: "consumer" })
  const result = yield* agent.turn({
    turn: { session: { id: view.header.id, owner: "consumer" }, userMessage: new UserMessage({ text: "hi" }), runId: "run-telemetry" },
    services: Context.merge(Context.make(LanguageModel.LanguageModel, llm), Context.make(Sessions, sessions)),
  }, (turn) => turn.run({}).pipe(Effect.map((run) => ({ outcome: run.outcome, reply: Option.some(run.text) }))))
  const unflushed = posts.length
  yield* flushTelemetry
  // Copied inside the layer: what the layer's close would post later does not count.
  return { result, session: view.header.id, unflushed, flushed: [...posts] }
})).pipe(Effect.provide(OtlpTelemetryLive({ baseUrl, protocol: "http/json", serviceName: "telemetry-consumer", exportInterval: "1 hour" }))))
server.close()

if (result.outcome !== "completed") fail(`the turn ended ${result.outcome}`)
if (unflushed !== 0) fail(`${unflushed} posts arrived before flushTelemetry`)
const breakdown = usageBreakdown(result.usage)
if (result.usage.cacheWriteTokens !== 10 || result.usage.reasoningTokens !== 5 || breakdown.input !== 60 || breakdown.output !== 15) {
  fail(`unexpected usage ${JSON.stringify(result.usage)}`)
}

const valueOf = (value) => value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue
const attributesOf = (list) => Object.fromEntries((list ?? []).map((entry) => [entry.key, valueOf(entry.value)]))
const bodies = (path) => flushed.filter((post) => post.path === path).map((post) => {
  if (post.contentType !== "application/json") fail(`${path} was posted as ${post.contentType}`)
  return JSON.parse(post.body)
})

const traces = bodies("/v1/traces")
const spans = traces.flatMap((body) => body.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)))
const turnSpan = spans.find((span) => span.name === "agent.turn")
if (turnSpan === undefined) fail(`no agent.turn span among ${JSON.stringify(spans.map((span) => span.name))}`)
const turnAttributes = attributesOf(turnSpan.attributes)
if (turnAttributes["efferent.session.id"] !== session || turnAttributes["efferent.run.id"] !== "run-telemetry" || Number(turnAttributes["efferent.turn"]) !== 1) {
  fail(`agent.turn carries ${JSON.stringify(turnAttributes)}`)
}
if (!(turnSpan.events ?? []).some((event) => event.name === "efferent.step.usage")) fail("agent.turn has no efferent.step.usage event")
const runSpan = spans.find((span) => span.name === "engine.run")
if (runSpan?.parentSpanId !== turnSpan.spanId) fail("engine.run is not a child of agent.turn")
const service = attributesOf(traces[0].resourceSpans[0].resource.attributes)["service.name"]
if (service !== "telemetry-consumer") fail(`the resource's service.name is ${service}`)

const metrics = bodies("/v1/metrics").flatMap((body) => body.resourceMetrics.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics)))
const last = (name) => metrics.filter((metric) => metric.name === name).at(-1)
const points = (name) => (last(name)?.sum?.dataPoints ?? []).map((point) => ({ attributes: attributesOf(point.attributes), value: Number(point.asDouble ?? point.asInt) }))
const tokens = points("efferent.llm.tokens")
const cacheWrite = tokens.find((point) => point.attributes["efferent.token.kind"] === "cache_write" && point.attributes["efferent.model"] === model)
if (cacheWrite?.value !== 10) fail(`efferent.llm.tokens has ${JSON.stringify(tokens)}`)
if (tokens.reduce((sum, point) => sum + point.value, 0) !== result.usage.totalTokens) fail("the token kinds do not sum to the turn's total")
const cost = points("efferent.llm.cost")[0]?.value ?? 0
if (Math.abs(cost - costOf(result.usage, price)) > 1e-12) fail(`efferent.llm.cost is ${cost}`)

console.log(`A turn with the telemetry plugin flushed its agent.turn span and its usage and cost metrics over OTLP on ${runtime}`)
