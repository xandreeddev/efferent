/** Key-free packed accounting: a loop, a helper, and a late plugin-finalizer helper. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Option, Redacted, Schema, Tracer } from "effect"
import {
  ConversationId, costOf, definePlugin, RunContext, RunId,
  SessionLogMemoryLive, Sessions, turnBilledUsageOf, turnModelCallsOf,
  turnUsageOf, TurnAdmissionOpen, UserMessage, UtilityLlm,
} from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { modelsPlugin } from "@xandreed/plugin-models"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { telemetryPlugin } from "@xandreed/plugin-telemetry"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"

const model = "claude-opus-4-8"
const prices = {
  [`gateway:${model}`]: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  [`helper:${model}`]: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}
const placeholder = "accounting-fixture-opaque-placeholder"
const requests = []
const server = createServer((request, response) => {
  const chunks = []
  request.on("data", (chunk) => chunks.push(chunk))
  request.on("end", () => {
    requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) })
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({
      id: `msg_accounting_${requests.length}`, type: "message", role: "assistant", model,
      content: [{ type: "text", text: "The accounting fixture completed." }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 31, output_tokens: 7 },
    }))
  })
})
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
const origin = `http://127.0.0.1:${server.address().port}`
const workspace = await mkdtemp(join(tmpdir(), "efferent-accounting-"))
const spans = []
const tracer = Tracer.make({ span: (options) => { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
const lateHelper = definePlugin({
  id: "consumer/late-accounting-helper", version: "1", scope: "session",
  config: Schema.Struct({}), defaults: {},
  requires: [UtilityLlm, RunContext], provides: [],
  layer: () => Layer.effectDiscard(Effect.gen(function* () {
    const helper = yield* UtilityLlm
    yield* Effect.addFinalizer(() => helper.complete("Name the completed fixture.").pipe(
      Effect.catch((error) => Effect.die(error)), Effect.asVoid,
    ))
  })),
})

try {
  const report = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const context = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "process" } }).pipe(
      Layer.provideMerge(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
    ))
    const sessions = Context.get(context, Sessions)
    const agent = yield* Agent.define({
      plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin,
        { plugin: modelsPlugin, options: {
          storage: "memory", inheritPrevious: false,
          model: `gateway:${model}`, fastModel: `helper:${model}`,
          endpoints: {
            gateway: { api: "anthropic-messages", url: `${origin}/loop/v1`, apiKey: Redacted.make(placeholder) },
            helper: { api: "anthropic-messages", url: `${origin}/helper/v1`, apiKey: Redacted.make(placeholder) },
          },
        } }, lateHelper, { plugin: telemetryPlugin, options: { prices } }],
      workspace, limits: { streaming: false, maxSteps: 2 },
    })
    const address = { id: ConversationId.make("00000000-0000-4000-8000-000000008181"), owner: "accounting-fixture" }
    yield* sessions.create(address)
    const result = yield* agent.turn({
      turn: { session: address, runId: RunId.make("accounting-fixture"), userMessage: new UserMessage({ text: "Inspect call accounting." }) },
      services: Context.make(Sessions, sessions),
    }, (turn) => Effect.gen(function* () {
      const helper = yield* UtilityLlm
      const completed = yield* helper.complete("Name the starting fixture.")
      assert.equal(completed.model?.provider, "helper")
      assert.equal(completed.model?.modelId, model)
      yield* turn.tools.select(turn.userMessage)
      const done = yield* turn.run({})
      return { outcome: done.outcome, reply: Option.some(done.text) }
    }))
    const stored = yield* sessions.read(address)
    const calls = yield* turnModelCallsOf(stored, 1)
    const billed = yield* turnBilledUsageOf(stored, 1)
    const selected = yield* turnUsageOf(stored, 1)
    assert.equal(requests.length, 3)
    assert.equal(calls.length, requests.length)
    assert.deepEqual(calls.map((call) => call.purpose), ["Helper", "Loop", "Helper"])
    assert.deepEqual(calls.map((call) => call.model.value.provider), ["helper", "gateway", "helper"])
    assert.deepEqual(calls.map((call) => call.usage._tag), ["Known", "Known", "Known"])
    assert.deepEqual(calls.map((call) => call.outcome._tag), ["Completed", "Completed", "Completed"])
    assert.deepEqual(calls.map((call) => Option.isSome(call.run)), [false, true, false])
    assert.equal(new Set(calls.map((call) => `${call.callId}:${call.attempt}`)).size, 3)
    assert.equal(billed.totalTokens, 114)
    assert.equal(selected.totalTokens, 38)
    assert.deepEqual(result.usage, selected)
    assert.equal(JSON.stringify(stored).includes(placeholder), false)
    const span = spans.find((candidate) => candidate.name === "agent.turn")
    assert.ok(span, "the turn span was missing")
    const expected = calls.reduce((sum, call) => sum + costOf(call.usage.usage, prices[`${call.model.value.provider}:${model}`]), 0)
    assert.ok(Math.abs(span.attributes.get("efferent.cost") - expected) < 1e-12,
      `helper/finalizer cost was lost or selected usage double counted: ${span.attributes.get("efferent.cost")} vs ${expected}`)
    return { runtime: typeof Bun === "undefined" ? "Node" : "Bun", calls: calls.length, selected: selected.totalTokens, billed: billed.totalTokens, accountingVerified: true }
  })).pipe(Effect.withTracer(tracer), Effect.timeout("15 seconds")))
  assert.deepEqual(await readdir(workspace), [], "memory-only accounting wrote fixture files")
  console.log(`model-call ${JSON.stringify(report)}`)
} finally {
  await new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections() })
  await rm(workspace, { recursive: true, force: true })
}
