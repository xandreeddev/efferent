/** Local HTTP only: request-policy and call-accounting behavior over source and packed packages. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Fiber, Layer, Option, Redacted, Ref, Schema } from "effect"
import { Tool } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import {
  ConversationId, defineCapability, defineSkill, defineTool, entriesOfEvents,
  Failure, harnessCodeOf, journalSchemaOf, ModelRequestHook, readStored, replayModelRequest,
  RunId, SessionLogMemoryLive, Sessions, turnBilledUsageOf, turnModelCallsOf, TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { CurrentModelRetryPolicy, ModelRetryPolicy, modelsPlugin } from "@xandreed/plugin-models"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"

const model = "claude-opus-4-8"
const placeholder = "retry-fixture-opaque-placeholder"
const answer = "The retry fixture completed."
const Probe = Tool.make("retry_probe", {
  description: "Return the retry fixture checkpoint.", parameters: Tool.EmptyParams,
  success: Schema.String, failure: Failure, failureMode: "return",
})
const tool = { type: "tool_use", id: "toolu_retry_fixture", name: Probe.name, input: {} }
const message = (content = [{ type: "text", text: answer }], stop = "end_turn") => ({
  id: "msg_retry_fixture", type: "message", role: "assistant", model, content,
  stop_reason: stop, stop_sequence: null, usage: { input_tokens: 31, output_tokens: 7 },
})
const events = [
  { type: "message_start", message: { ...message([]), stop_reason: null, usage: { input_tokens: 31, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } },
  { type: "message_stop" },
]
const sse = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const json = (response, status, data, headers = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers })
  response.end(JSON.stringify(data))
}
const fail = (response, status, type = "overloaded_error", headers = {}) =>
  json(response, status, { type: "error", error: { type, message: "Fixture request rejected." } }, headers)
const policyValue = (overrides = {}) => ({
  maxAttempts: 4, requestTimeoutMs: 500, bodyIdleTimeoutMs: 150,
  totalTimeoutMs: 3_000, retryAfterMaxMs: 80,
  backoff: { initialMs: 0, maxMs: 0, jitter: 0 }, ...overrides,
})

const startServer = async (scenario) => {
  const requests = []
  const timers = new Set()
  const groups = new Map()
  const first = Promise.withResolvers()
  const firstClosed = Promise.withResolvers()
  const schedule = (delay, action) => {
    const timer = setTimeout(() => { timers.delete(timer); action() }, delay)
    timers.add(timer)
  }
  const server = createServer((request, response) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const observed = { path: request.url, body, at: performance.now(), closed: false }
      requests.push(observed)
      response.on("close", () => { observed.closed = true; firstClosed.resolve() })
      first.resolve()
      const number = requests.length
      const fallback = request.url.startsWith("/fallback/")
      response.setHeader("request-id", `req_retry_fixture_${number}`)
      if (scenario.mode === "mixed-tool") {
        if (number === 1) request.socket.destroy()
        else if (number === 2) fail(response, 429, "rate_limit_error", { "retry-after": "1" })
        else if (number === 3) fail(response, 529)
        else json(response, 200, number === 4 ? message([tool], "tool_use") : message())
      } else if (scenario.mode === "reserved-fallback") {
        if (fallback) json(response, 200, message())
        else fail(response, 503)
      } else if (scenario.mode === "same-fallback" || scenario.mode === "four-primary") {
        if (number < 4) fail(response, 503)
        else json(response, 200, message())
      } else if (scenario.mode === "permanent") {
        if (scenario.status === 413) {
          response.writeHead(413, { "content-type": "text/plain" })
          response.end("Fixture request body exceeds the HTTP size limit.")
        } else fail(response, scenario.status, scenario.errorType)
      } else if (scenario.mode === "max-one") {
        if (number === 1) fail(response, 503)
        else json(response, 200, message())
      } else if (scenario.mode === "headers" || scenario.mode === "cancel-headers") {
        // No headers arrive. Fixture cleanup closes this socket even on failure.
      } else if (scenario.mode === "body") {
        response.writeHead(200, { "content-type": "application/json" })
        response.write('{"id":')
      } else if (scenario.mode === "sse-idle") {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(events.slice(0, 3).map(sse).join(""))
      } else if (scenario.mode === "sse-progress") {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.flushHeaders()
        events.forEach((event, index) => schedule(index * 35, () => {
          if (!response.destroyed) {
            response.write(sse(event))
            if (index === events.length - 1) response.end()
          }
        }))
      } else if (scenario.mode === "cancel-sleep") {
        fail(response, 429, "rate_limit_error", { "retry-after": "1" })
      } else if (scenario.mode === "stream-fallback") {
        if (body.stream) {
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.end(sse({ type: "error", error: { type: "overloaded_error", message: "Fixture stream not available." }, request_id: "req_retry_stream_fixture" }))
        } else json(response, 200, message())
      } else if (scenario.mode === "concurrent") {
        const group = JSON.stringify(body.messages).includes("concurrent-one") ? "one" : "four"
        const count = (groups.get(group) ?? 0) + 1
        groups.set(group, count)
        if (count < 4) fail(response, 503)
        else json(response, 200, message())
      } else assert.fail(`unknown fixture mode ${scenario.mode}`)
    })
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  return {
    requests, groups, first: first.promise, firstClosed: firstClosed.promise,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      timers.forEach(clearTimeout)
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}

const scenarios = [
  { name: "mixed-one-counter-and-tool-once", mode: "mixed-tool", calls: 5, handlers: 1, fallback: "distinct", policy: { requestTimeoutMs: 80 } },
  { name: "four-primary-attempts", mode: "four-primary", calls: 4 },
  { name: "distinct-fallback-reserves-final-slot", mode: "reserved-fallback", calls: 4, fallback: "distinct" },
  { name: "identical-fallback-keeps-primary-budget", mode: "same-fallback", calls: 4, fallback: "same" },
  { name: "max-one-never-adds-fallback", mode: "max-one", calls: 1, fallback: "distinct", policy: { maxAttempts: 1 }, code: "model.unavailable" },
  { name: "structured-429-invalid-request-is-permanent", mode: "permanent", status: 429, errorType: "invalid_request_error", calls: 1, fallback: "distinct", code: "model.invalid-request" },
  { name: "structured-402-auth-is-permanent", mode: "permanent", status: 402, errorType: "authentication_error", calls: 1, fallback: "distinct", code: "model.auth" },
  { name: "bare-413-is-not-context", mode: "permanent", status: 413, calls: 1, fallback: "distinct", code: "model.invalid-request" },
  { name: "pending-headers-timeout", mode: "headers", calls: 1, policy: { maxAttempts: 1, requestTimeoutMs: 80 }, code: "model.timeout" },
  { name: "successful-headers-stalled-body-timeout", mode: "body", calls: 1, fallback: "distinct", policy: { bodyIdleTimeoutMs: 80 }, code: "model.timeout" },
  { name: "partial-sse-idle-timeout", mode: "sse-idle", calls: 1, streaming: true, policy: { bodyIdleTimeoutMs: 80 }, code: "model.timeout" },
  { name: "progressing-sse-outlives-header-timeout", mode: "sse-progress", calls: 1, streaming: true, policy: { requestTimeoutMs: 80, bodyIdleTimeoutMs: 120 } },
  { name: "cancel-pending-headers", mode: "cancel-headers", calls: 1, cancel: true },
  { name: "cancel-retry-after-sleep", mode: "cancel-sleep", calls: 1, cancel: true, policy: { retryAfterMaxMs: 1_000 } },
  { name: "stream-fallback-keeps-frozen-step", mode: "stream-fallback", calls: 2, streaming: true, policy: { maxAttempts: 1 } },
  { name: "concurrent-reference-overrides", mode: "concurrent", calls: 5 },
]

const runCase = async (scenario, index) => {
  const server = await startServer(scenario)
  const fetchAborted = Promise.withResolvers()
  const observingFetch = Object.assign((input, init) => {
    if (init?.signal?.aborted) fetchAborted.resolve()
    else init?.signal?.addEventListener("abort", () => fetchAborted.resolve(), { once: true })
    return globalThis.fetch(input, init)
  }, { preconnect() {} })
  const workspace = await mkdtemp(join(tmpdir(), "efferent-model-retry-")).catch(async (error) => { await server.close(); throw error })
  try {
    const report = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const context = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(
        Layer.provideMerge(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
      ))
      const sessions = Context.get(context, Sessions)
      const handlers = yield* Ref.make(0)
      const agent = yield* Agent.define({
        plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: modelsPlugin, options: {
          storage: "memory", inheritPrevious: false, model: `gateway:${model}`,
          ...(scenario.fallback === "distinct" ? { fallbackModel: `backup:${model}` } : scenario.fallback === "same" ? { fallbackModel: `gateway:${model}` } : {}),
          endpoints: {
            gateway: { api: "anthropic-messages", url: `${server.origin}/v1`, apiKey: Redacted.make(placeholder) },
            backup: { api: "anthropic-messages", url: `${server.origin}/fallback/v1`, apiKey: Redacted.make(placeholder) },
          },
        } }],
        capabilities: [defineCapability({ id: "model-retry-fixture", version: "1",
          tools: [defineTool({ tool: Probe, handler: () => Ref.update(handlers, (count) => count + 1).pipe(
            Effect.andThen(Effect.sleep(120)), Effect.as("The retry checkpoint was recorded."),
          ), annotations: { readOnly: true } })],
          skills: [defineSkill({ id: "model-retry-fixture", summary: "Use the retry fixture checkpoint.", always: true, tools: [Probe.name] })],
        })], workspace, limits: { streaming: scenario.streaming === true, maxSteps: 3 },
      })
      const run = (suffix, overrides) => Effect.gen(function* () {
        const address = { id: ConversationId.make(`00000000-0000-4000-8000-${String(7000 + index * 2 + suffix).padStart(12, "0")}`), owner: "model-retry-fixture" }
        yield* sessions.create(address)
        const policy = yield* Schema.decodeUnknownEffect(ModelRetryPolicy)(policyValue(overrides))
        const runId = RunId.make(`retry-${scenario.name}-${suffix}`)
        const published = []
        const modelDecisions = []
        const stepDecisions = []
        const hookDecisions = []
        const services = Context.make(Sessions, sessions).pipe(Context.add(ModelRequestHook, ModelRequestHook.of({
          prepare: (draft) => Effect.sync(() => { hookDecisions.push(draft.step); return {} }),
        })))
        const operation = agent.turn({ turn: { session: address, runId, userMessage: new UserMessage({ text: scenario.mode === "concurrent" ? `concurrent-${suffix === 0 ? "one" : "four"}` : "Inspect the retry fixture." }) }, services },
          (turn) => Effect.gen(function* () {
            yield* turn.events.subscribe((event) => Option.some(event), (event) => Effect.sync(() => { published.push(event) }))
            yield* turn.tools.select(turn.userMessage)
            const running = turn.run({
              stepContext: "tail",
              model: (info) => Effect.sync(() => { modelDecisions.push(info.stepIndex); return Option.none() }),
              step: (info) => Effect.sync(() => { stepDecisions.push(info.stepIndex); return { context: Option.some(`Retry checkpoint step ${info.stepIndex}.`), toolChoice: Option.none() } }),
            }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy))
            const done = yield* scenario.mode === "cancel-headers"
              ? running.pipe(Effect.provideService(FetchHttpClient.Fetch, observingFetch)) : running
            return { outcome: done.outcome, reply: Option.some(done.text) }
          }))
        const result = scenario.cancel ? yield* Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(operation)
          yield* Effect.tryPromise(() => server.first)
          if (scenario.mode === "cancel-sleep") yield* Effect.sleep(25)
          yield* Fiber.interrupt(fiber)
          if (scenario.mode === "cancel-headers") {
            yield* Effect.tryPromise(() => fetchAborted.promise)
            // Bun1.3.0 rejects an aborted fetch while keeping this socket open;
            // Node also supplies socket-close evidence. Cleanup closes both.
            if (typeof Bun === "undefined") yield* Effect.tryPromise(() => server.firstClosed)
          }
          return { _tag: "Interrupted" }
        }) : yield* Effect.result(operation)
        const stored = yield* sessions.read(address)
        yield* Effect.forEach(stored, (event) => Option.match(journalSchemaOf(event.kind), {
          onNone: () => Effect.die(`unrecognized fixture journal kind ${event.kind}`),
          onSome: (schema) => Schema.decodeUnknownEffect(schema)(event.data),
        }), { concurrency: 1, discard: true })
        const headers = yield* readStored("request.prepared", stored)
        const calls = yield* turnModelCallsOf(stored, 1)
        const billed = yield* turnBilledUsageOf(stored, 1)
        assert.ok(!JSON.stringify(stored).includes(placeholder), "request credentials entered the journal")
        return { result, stored, headers, calls, billed, published, modelDecisions, stepDecisions, hookDecisions, runId }
      })
      const outcomes = scenario.mode === "concurrent"
        ? yield* Effect.all([run(0, { maxAttempts: 1 }), run(1, { maxAttempts: 4 })], { concurrency: 2 })
        : [yield* run(0, scenario.policy)]
      const terminal = outcomes.map(({ result }) => result._tag === "Failure"
        ? `${Option.getOrElse(harnessCodeOf(result.failure), () => result.failure._tag)}: ${result.failure.message}` : result._tag)
      assert.equal(server.requests.length, scenario.calls, `${scenario.name}: physical send count changed (${terminal.join("; ")})`)
      assert.equal(yield* Ref.get(handlers), scenario.handlers ?? 0, `${scenario.name}: an incomplete/retried response ran a tool`)
      for (const [position, outcome] of outcomes.entries()) {
        const expectedCalls = scenario.mode === "concurrent" ? position === 0 ? 1 : 4 : scenario.calls
        assert.equal(outcome.calls.length, expectedCalls, `${scenario.name}: a dispatched attempt was lost or recorded twice`)
        assert.equal(new Set(outcome.calls.map((call) => `${call.callId}:${call.attempt}`)).size, expectedCalls, "duplicate model-call terminal facts")
        const callGroups = Map.groupBy(outcome.calls, (call) => call.callId)
        for (const attempts of callGroups.values()) assert.deepEqual(attempts.map((call) => call.attempt), attempts.map((_, ordinal) => ordinal + 1), "one logical call lost its attempt sequence")
        for (const call of outcome.calls) {
          assert.equal(call.purpose, "Loop")
          assert.equal(Option.getOrElse(call.runId, () => ""), outcome.runId, "model-call correlation lost its admitted run")
          assert.equal(Option.getOrElse(call.run, () => -1), outcome.headers[0].data.run)
          assert.ok(Option.isSome(call.step), "a loop attempt lost its step")
          assert.ok(call.durationMs >= 0 && Number.isFinite(call.durationMs))
          assert.ok(Option.exists(call.model, (selection) => selection.modelId === model), "actual invoked model was not retained")
          assert.equal(Option.getOrElse(Option.map(call.model, (selection) => selection.provider), () => ""),
            (scenario.mode === "mixed-tool" || scenario.mode === "reserved-fallback") && call.attempt === 4 ? "backup" : "gateway",
            "request candidates replaced the actual invoked provider")
        }
        const notifications = outcome.published.filter((event) => event._tag === "model.called").length
        // Cancellation can close this caller-scoped subscription before the
        // terminal cleanup notification. Durable facts remain mandatory above.
        if (scenario.cancel) assert.ok(notifications <= expectedCalls, "terminal notifications were duplicated")
        else assert.equal(notifications, expectedCalls, `${scenario.name}: terminal notifications were duplicated or omitted`)
        const expectedBilled = scenario.mode === "mixed-tool" ? 76
          : scenario.mode === "sse-idle" ? 31
          : scenario.cancel || scenario.code || (scenario.mode === "concurrent" && position === 0) ? 0 : 38
        assert.equal(outcome.billed.totalTokens, expectedBilled, `${scenario.name}: selected and billed usage were mixed or reported usage was lost`)
        const expectedCode = scenario.mode === "concurrent" ? position === 0 ? "model.unavailable" : undefined : scenario.code
        if (scenario.cancel) assert.equal(outcome.result._tag, "Interrupted")
        else if (expectedCode) {
          assert.equal(outcome.result._tag, "Failure", `${scenario.name}: a failed request completed`)
          assert.equal(Option.getOrElse(harnessCodeOf(outcome.result.failure), () => outcome.result.failure._tag), expectedCode, `${scenario.name}: failure meaning was lost`)
        } else {
          assert.equal(outcome.result._tag, "Success", `${scenario.name}: ${outcome.result.failure?.message ?? "request failed"}`)
          assert.equal(Option.getOrElse(outcome.result.success.reply, () => ""), answer)
        }
        const ended = outcome.stored.filter((event) => event.kind === "turn.ended")
        assert.equal(ended.length, 1, "request retry duplicated or lost turn termination")
        if (expectedCode) {
          assert.equal(ended[0].data.reason, "failed")
          assert.equal(ended[0].data.failure.code, expectedCode, "the durable failure code changed")
        }
        const expectedHeaders = scenario.mode === "mixed-tool" ? 2 : 1
        assert.equal(outcome.headers.length, expectedHeaders, `${scenario.name}: transport attempts changed prepared-step count`)
        assert.deepEqual(outcome.modelDecisions, scenario.mode === "mixed-tool" ? [0, 1] : [0], "transport retry reevaluated policy.model")
        assert.deepEqual(outcome.stepDecisions, outcome.modelDecisions, "transport retry reevaluated policy.step")
        assert.deepEqual(outcome.hookDecisions, outcome.modelDecisions, "transport retry or fallback reevaluated the request hook")
        assert.ok(outcome.headers.every(({ data }) => JSON.stringify(data.hook) === "{}"), "a retry header lost its accepted empty hook patch")
        assert.equal(outcome.stored.filter((event) => event.kind === "memory.step").length, expectedHeaders, "transport retry duplicated StepContext")
        const entries = yield* entriesOfEvents(outcome.stored)
        assert.equal(entries.filter((entry) => entry.body._tag === "ToolResult").length, scenario.handlers ?? 0, "tool execution was not durable exactly once")
        assert.equal(outcome.published.filter((event) => event._tag === "tool.started").length, scenario.handlers ?? 0, "request retry admitted a tool more than once")
        assert.equal(outcome.published.filter((event) => event._tag === "stream.fallback").length, scenario.mode === "stream-fallback" ? 1 : 0, "unexpected stream fallback")
        if (!scenario.cancel) yield* Effect.forEach(outcome.headers, ({ data }) => replayModelRequest(outcome.stored, outcome.runId, data.step, data.run).pipe(Effect.tap((request) => Effect.sync(() => {
          assert.ok(Option.exists(request.model, (descriptor) => descriptor.provider === "gateway" && descriptor.model === model), "replay lost the frozen requested model")
        }))), { concurrency: 1, discard: true })
      }
      if (scenario.mode === "mixed-tool") {
        const delay = server.requests[2].at - server.requests[1].at
        assert.ok(delay >= 70, `Retry-After was not slept: ${delay}ms for an80ms capped hint`)
        assert.ok(delay < 1_000, "Retry-After cap was not applied")
        assert.deepEqual(server.requests.slice(0, 4).map((request) => request.body), Array(4).fill(server.requests[0].body), "transport retry changed the frozen request")
        assert.deepEqual(server.requests.map((request) => request.path.startsWith("/fallback/")), [false, false, false, true, false], "mixed failures did not share the primary/fallback counter")
        assert.equal(server.requests[4].body.messages.flatMap((message) => message.content).filter((part) => part.type === "tool_result").length, 1)
      }
      if (scenario.mode === "reserved-fallback") assert.deepEqual(server.requests.map((request) => request.path.startsWith("/fallback/")), [false, false, false, true])
      if (scenario.mode === "same-fallback") assert.ok(server.requests.every((request) => !request.path.startsWith("/fallback/")))
      if (scenario.mode === "stream-fallback") {
        assert.deepEqual(server.requests.map((request) => request.body.stream === true), [true, false])
        const withoutStream = ({ stream, ...body }) => body
        assert.deepEqual(withoutStream(server.requests[0].body), withoutStream(server.requests[1].body), "stream fallback changed the frozen step request")
      }
      if (scenario.mode === "concurrent") assert.deepEqual(Object.fromEntries(server.groups), { one: 1, four: 4 })
      return { name: scenario.name, calls: server.requests.length, handlers: yield* Ref.get(handlers), headers: outcomes.map((outcome) => outcome.headers.length), retryVerified: true, accountingVerified: true, hookVerified: true }
    })).pipe(Effect.timeout("8 seconds")))
    assert.deepEqual(await readdir(workspace), [], "memory configuration wrote fixture files")
    return report
  } finally {
    await server.close()
    await rm(workspace, { recursive: true, force: true })
  }
}

const watchdog = setTimeout(() => { console.error("the model-retry fixture timed out"); process.exit(2) }, 55_000)
watchdog.unref()
try {
  const selected = process.argv.find((argument) => argument.startsWith("--case="))?.slice(7)
  const reports = []
  for (const [index, scenario] of scenarios.entries()) if (selected === undefined || selected === scenario.name) reports.push(await runCase(scenario, index))
  assert.ok(reports.length > 0, "no model-retry fixture scenario was selected")
  console.log(`model-retry ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", reports })}`)
} finally { clearTimeout(watchdog) }
