/** Real Agent failures over local HTTP; no provider calls or credentials. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect"
import { Tool } from "effect/ai"
import {
  ConversationId, defineCapability, defineSkill, defineTool, entriesOfEvents,
  Failure, harnessCodeOf, journalSchemaOf, readStored, replayModelRequest,
  RunId, SessionLogMemoryLive, Sessions, turnBilledUsageOf, turnModelCallsOf, TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { modelsPlugin } from "@xandreed/plugin-models"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"

const model = "claude-opus-4-8"
const placeholder = "model-failure-fixture-placeholder"
const toolId = "toolu_failure_fixture"
const Probe = Tool.make("failure_probe", {
  description: "Return the failure fixture checkpoint.", parameters: Tool.EmptyParams,
  success: Schema.String, failure: Failure, failureMode: "return",
})
const usage = { input_tokens: 101, output_tokens: 7 }
const tool = { type: "tool_use", id: toolId, name: Probe.name, input: {} }
const message = (stop, content = [tool]) => ({
  id: "msg_failure_fixture", type: "message", role: "assistant", model,
  content, stop_reason: stop, stop_sequence: null, usage,
})
const start = (stop = null) => ({ type: "message_start", message: { ...message(stop, []), usage: { ...usage, output_tokens: 0 } } })
const textEvents = [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial fixture content." } },
  { type: "content_block_stop", index: 0 },
]
const toolEvents = [
  { type: "content_block_start", index: 1, content_block: tool },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
  { type: "content_block_stop", index: 1 },
]
const stopEvent = (reason) => ({ type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, server_tool_use: null, output_tokens: 7 } })
const permanentError = (type, message) => ({ type: "error", error: { type, message }, request_id: "req_failure_fixture" })
const scenarios = [
  { name: "settled-overflow-with-tool", kind: "settled", stop: "model_context_window_exceeded", code: "model.context-overflow" },
  { name: "stream-start-overflow", kind: "stream", events: [start("model_context_window_exceeded"), ...textEvents, ...toolEvents, { type: "message_stop" }], code: "model.context-overflow" },
  { name: "stream-delta-overflow-after-tool-args", kind: "stream", events: [start(), ...textEvents, ...toolEvents, stopEvent("model_context_window_exceeded"), { type: "message_stop" }], code: "model.context-overflow" },
  { name: "stream-context-error-before-content", kind: "stream", events: [permanentError("invalid_request_error", "prompt is too long: 200001 tokens > 200000 maximum")], code: "model.context-overflow" },
  { name: "stream-auth-error-before-content", kind: "stream", events: [permanentError("authentication_error", "Fixture authentication denied.")], code: "model.auth" },
  { name: "stream-auth-error-after-content", kind: "stream", events: [start(), ...textEvents, ...toolEvents, permanentError("authentication_error", "Fixture authentication denied.")], code: "model.auth" },
  { name: "stream-invalid-error-after-content", kind: "stream", events: [start(), ...textEvents, ...toolEvents, permanentError("invalid_request_error", "The thinking budget must be less than max_tokens.")], code: "model.invalid-request" },
  { name: "http-auth", kind: "http", status: 401, type: "authentication_error", description: "Fixture authentication denied.", code: "model.auth" },
  { name: "http-quota", kind: "http", status: 402, type: "billing_error", description: "Fixture balance exhausted.", code: "model.quota" },
  { name: "http-invalid-request", kind: "http", status: 400, type: "invalid_request_error", description: "The thinking budget must be less than max_tokens.", code: "model.invalid-request" },
  { name: "http-size-413-is-not-context", kind: "http", status: 413, type: "request_too_large", description: "Fixture request body is too large.", code: "model.invalid-request" },
  { name: "compat-context-code", kind: "compat", status: 400, type: "invalid_request_error", description: "Fixture context rejected.", code: "model.context-overflow" },
  { name: "ordinary-output-limit-remains-bounded", kind: "cut", stop: "max_tokens", code: "loop.truncated" },
]

const startServer = async (scenario) => {
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const fallback = request.url.startsWith("/fallback/")
      requests.push({ path: request.url, body, fallback })
      response.setHeader("request-id", "req_failure_fixture")
      // Legacy retry/fallback paths stop quickly instead of waiting through
      // transient backoff. Their extra request still fails the assertions.
      if (fallback || (requests.length > 1 && scenario.kind !== "cut")) {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify(fallback || scenario.kind === "compat"
          ? { choices: [{ finish_reason: "stop", message: { content: "Unexpected second request." } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
          : message("end_turn", [{ type: "text", text: "Unexpected second request." }])))
      } else if (scenario.kind === "stream") {
        response.setHeader("content-type", "text/event-stream")
        response.end(scenario.events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""))
      } else if (scenario.kind === "http" || scenario.kind === "compat") {
        response.statusCode = scenario.status
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ type: "error", error: { type: scenario.type, message: scenario.description,
          ...(scenario.kind === "compat" ? { code: "context_length_exceeded" } : {}) } }))
      } else {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify(message(scenario.stop)))
      }
    })
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  return { requests, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  }) }
}

const runCase = async (scenario, index) => {
  const server = await startServer(scenario)
  const workspace = await mkdtemp(join(tmpdir(), "efferent-model-failure-")).catch(async (error) => { await server.close(); throw error })
  try {
    const report = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const context = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(
        Layer.provideMerge(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
      ))
      const sessions = Context.get(context, Sessions)
      const address = { id: ConversationId.make(`00000000-0000-4000-8000-${String(6000 + index).padStart(12, "0")}`), owner: "model-failures-fixture" }
      yield* sessions.create(address)
      const handlers = yield* Ref.make(0)
      const published = []
      const agent = yield* Agent.define({
        plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: modelsPlugin, options: {
          storage: "memory", inheritPrevious: false, model: `gateway:${model}`, fallbackModel: "backup:fixture-chat",
          endpoints: { gateway: { ...(scenario.kind === "compat" ? {} : { api: "anthropic-messages" }), url: `${server.origin}/v1`, apiKey: Redacted.make(placeholder) },
            backup: { url: `${server.origin}/fallback/v1`, apiKey: "" } },
        } }],
        capabilities: [defineCapability({ id: "model-failure-fixture", version: "1",
          tools: [defineTool({ tool: Probe, handler: () => Ref.update(handlers, (count) => count + 1).pipe(Effect.as("This handler must not run.")), annotations: { readOnly: true } })],
          skills: [defineSkill({ id: "model-failure-fixture", summary: "Use the failure fixture checkpoint.", always: true, tools: [Probe.name] })],
        })], workspace, limits: { streaming: scenario.kind === "stream", maxSteps: 4 },
      })
      const runId = RunId.make(`failure-${scenario.name}`)
      const result = yield* Effect.result(agent.turn({ turn: { session: address, runId, userMessage: new UserMessage({ text: "Inspect the failure fixture." }) }, services: Context.make(Sessions, sessions) },
        (turn) => Effect.gen(function* () {
          yield* turn.events.subscribe((event) => Option.some(event), (event) => Effect.sync(() => { published.push(event) }))
          yield* turn.tools.select(turn.userMessage)
          const done = yield* turn.run({})
          return { outcome: done.outcome, reply: Option.some(done.text) }
        })).pipe(Effect.timeout("5 seconds")))
      assert.equal(result._tag, "Failure", `${scenario.name}: the failed model request completed the turn`)
      const code = Option.getOrElse(harnessCodeOf(result.failure), () => result.failure._tag)
      assert.equal(code, scenario.code, `${scenario.name}: model failure meaning was lost`)
      if (scenario.kind !== "cut") assert.equal(result.failure.cause?._tag, "AiError", `${scenario.name}: the original typed provider failure was lost`)
      if (scenario.kind === "settled" || scenario.kind === "stream") {
        const reason = result.failure.cause.reason
        assert.equal(reason.http.response.status, 200, "a raw provider failure lost its successful HTTP status")
        assert.deepEqual(reason.http.request.headers, {}, "a raw provider failure retained request credentials")
        assert.ok(!JSON.stringify(reason.http.request).includes(placeholder), "a credential entered raw failure diagnostics")
        assert.equal(reason.metadata.anthropic.requestId, "req_failure_fixture", "raw failure metadata lost the request id")
        const raw = JSON.parse(reason.http.body)
        if (scenario.kind === "settled") {
          assert.equal(raw.stop_reason, "model_context_window_exceeded", "the raw stop reason was replaced by normalized length")
          assert.deepEqual(raw.usage, usage, "the raw overflow response lost token usage")
          assert.deepEqual(raw.content, [tool], "the raw overflow response lost its unexecuted tool call")
        } else {
          const failedEvent = scenario.events.find((event) => event.type === "error"
            || (event.type === "message_start" && event.message.stop_reason === "model_context_window_exceeded")
            || (event.type === "message_delta" && event.delta.stop_reason === "model_context_window_exceeded"))
          assert.equal(raw.event.type, failedEvent.type, "stream diagnostics lost the raw failure event")
          if (failedEvent.type === "error") assert.deepEqual(raw.event.error, failedEvent.error, "stream diagnostics replaced the raw provider error")
          if (scenario.events.some((event) => event.type === "message_start")) {
            assert.equal(raw.usage.input_tokens, 101, "stream diagnostics lost known input usage")
            assert.equal(raw.usage.output_tokens, failedEvent.type === "message_delta" ? 7 : 0, "stream diagnostics invented or lost known output usage")
          } else assert.deepEqual(raw.usage, {}, "an error before message_start invented token usage")
        }
      }
      assert.equal(yield* Ref.get(handlers), 0, `${scenario.name}: an incomplete or failed response ran a handler`)
      const events = yield* sessions.read(address)
      yield* Effect.forEach(events, (event) => Option.match(journalSchemaOf(event.kind), {
        onNone: () => Effect.die(`unrecognized fixture journal kind ${event.kind}`),
        onSome: (schema) => Schema.decodeUnknownEffect(schema)(event.data),
      }), { concurrency: 1, discard: true })
      const ended = events.filter((event) => event.kind === "turn.ended")
      assert.equal(ended.length, 1, `${scenario.name}: turn termination was duplicated`)
      assert.equal(ended[0].data.reason, "failed")
      assert.equal(ended[0].data.failure.code, scenario.code, `${scenario.name}: the durable failure code changed`)
      const requests = yield* readStored("request.prepared", events)
      const expectedCalls = scenario.kind === "cut" ? 3 : 1
      const calls = yield* turnModelCallsOf(events, 1)
      const billed = yield* turnBilledUsageOf(events, 1)
      assert.equal(calls.length, expectedCalls, `${scenario.name}: a discarded or failed attempt lost its call fact`)
      assert.equal(new Set(calls.map((call) => `${call.callId}:${call.attempt}`)).size, expectedCalls, "a failed attempt was recorded twice")
      assert.ok(calls.every((call) => call.purpose === "Loop" && Option.exists(call.model, (selection) => selection.provider === "gateway" && selection.modelId === model)), "a failure lost its actual invoked model")
      assert.ok(calls.every((call) => call.outcome._tag === (scenario.kind === "cut" ? "Completed" : "Failed")), "consumer acceptance replaced the physical provider outcome")
      const reportedInput = scenario.kind === "stream" && scenario.events.some((event) => event.type === "message_start")
      const finalUsage = scenario.kind === "settled" || scenario.kind === "cut" || scenario.name === "stream-delta-overflow-after-tool-args"
      const expectedUsage = finalUsage ? "Known" : reportedInput ? "Partial" : "Unknown"
      assert.ok(calls.every((call) => call.usage._tag === expectedUsage), `${scenario.name}: unknown/partial/final usage precision was lost`)
      assert.equal(billed.totalTokens, finalUsage ? expectedCalls * 108 : reportedInput ? 101 : 0, `${scenario.name}: failed raw usage was lost or counted twice`)
      assert.equal(requests.length, expectedCalls, `${scenario.name}: request evidence was lost or a corrective request was added`)
      yield* Effect.forEach(requests, ({ data }) => replayModelRequest(events, runId, data.step, data.run).pipe(Effect.tap((request) => Effect.sync(() => {
        assert.ok(Option.exists(request.model, (descriptor) => descriptor.provider === "gateway" && descriptor.model === model), "replay lost requested model identity")
      }))), { concurrency: 1, discard: true })
      assert.deepEqual(events.filter((event) => event.kind === "step.ended").map((event) => event.data.status), Array(expectedCalls).fill(scenario.kind === "cut" ? "truncated" : "failed"))
      assert.equal(published.filter((event) => event._tag === "stream.fallback").length, 0, `${scenario.name}: a permanent failure caused stream fallback`)
      assert.equal(published.filter((event) => event._tag === "tool.started").length, 0, `${scenario.name}: a failed response admitted a tool call`)
      assert.equal(published.filter((event) => event._tag === "step.ended" && event.status === "malformed").length, 0, `${scenario.name}: a provider failure became a malformed corrective`)
      if (scenario.kind !== "cut") {
        const entries = yield* entriesOfEvents(events)
        assert.equal(entries.filter((entry) => entry.body._tag === "ToolResult").length, 0, "a permanent failure recorded a tool result")
        assert.equal(entries.filter((entry) => entry.body._tag === "Message" && entry.body.message.role === "assistant").length, 0, "a permanent failure stored an incomplete assistant reply")
        assert.equal(entries.filter((entry) => entry.body._tag === "Message" && entry.body.message.role === "user").length, 0, "a permanent failure recorded a corrective message")
      }
      assert.equal(server.requests.length, expectedCalls, `${scenario.name}: a permanent failure retried or fell back`)
      assert.equal(server.requests.filter((request) => request.fallback).length, 0, `${scenario.name}: a fallback provider was called`)
      assert.ok(!JSON.stringify(events).includes(placeholder), "a credential entered the durable journal")
      return { name: scenario.name, code, calls: server.requests.length, handlers: yield* Ref.get(handlers), headers: requests.length, failureVerified: true, accountingVerified: true }
    })))
    assert.deepEqual(await readdir(workspace), [], "memory configuration wrote fixture files")
    return report
  } finally {
    await server.close()
    await rm(workspace, { recursive: true, force: true })
  }
}

const watchdog = setTimeout(() => { console.error("the model-failure fixture timed out"); process.exit(2) }, 80_000)
watchdog.unref()
try {
  const selected = process.argv.find((argument) => argument.startsWith("--case="))?.slice(7)
  const reports = []
  for (const [index, scenario] of scenarios.entries()) if (selected === undefined || selected === scenario.name) reports.push(await runCase(scenario, index))
  assert.ok(reports.length > 0, "no model-failure fixture scenario was selected")
  console.log(`model-failures ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", reports })}`)
} finally { clearTimeout(watchdog) }
