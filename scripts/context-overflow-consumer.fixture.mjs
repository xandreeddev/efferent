/** Key-free real-Agent overflow recovery, shared by source and packed runtimes. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect"
import { Tool } from "effect/ai"
import {
  ConversationId, ConversationMemory, defineCapability, definePlugin, defineSkill,
  defineTool, entriesOfEvents, Failure, harnessCodeOf, journalSchemaOf, readStored,
  replayModelRequest, RunId, SessionLogMemoryLive, Sessions, toolCallStatesOf,
  turnBilledUsageOf, turnModelCallsOf, TurnAdmissionOpen, UserMessage, UtilityLlm,
} from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { MemorySummaryConfig, memorySummaryDefaults, memorySummaryPlugin } from "@xandreed/plugin-memory-summary"
import { CurrentModelRetryPolicy, modelRetryDefaults, modelsPlugin } from "@xandreed/plugin-models"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"

const model = "claude-opus-4-8"
const placeholder = "overflow-fixture-opaque-placeholder"
const older = "Earlier overflow evidence checkpoint. ".repeat(360)
const summary = "Earlier checkpoint preserved."
const visible = "Visible before overflow."
const toolId = "toolu_overflow_checkpoint"
const usage = { input_tokens: 101, output_tokens: 7 }
const Probe = Tool.make("overflow_checkpoint", {
  description: "Return the overflow fixture checkpoint.", parameters: Tool.EmptyParams,
  success: Schema.String, failure: Failure, failureMode: "return",
})
const tool = { type: "tool_use", id: toolId, name: Probe.name, input: {} }
const message = (stop, content) => ({
  id: "msg_overflow_fixture", type: "message", role: "assistant", model,
  content, stop_reason: stop, stop_sequence: null, usage,
})
const start = () => ({ type: "message_start", message: { ...message(null, []), usage: { input_tokens: 101, output_tokens: 0 } } })
const textEvents = (text) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
]
const errorEvent = (type, text) => ({ type: "error", error: { type, message: text }, request_id: "req_overflow_fixture" })
const contextError = () => errorEvent("invalid_request_error", "prompt is too long: 200001 tokens > 200000 maximum")
const eventsFor = (content, stop) => [start(), ...content.flatMap((part, index) => part.type === "text" ? textEvents(part.text) : [
  { type: "content_block_start", index, content_block: part },
  { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "{}" } },
  { type: "content_block_stop", index },
]), { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 7 } }, { type: "message_stop" }]
const cases = [
  { name: "raw200-summary-tool-once" },
  { name: "http400-summary", http: 400 },
  { name: "explicit-context413-summary", http: 413 },
  { name: "precontent-sse-metadata", streaming: true },
  { name: "late-visible-declines", streaming: true, late: true, fails: true },
  { name: "irreducible-current-turn", irreducible: true, fails: true },
  { name: "one-resend-per-step", repeat: true, fails: true },
  { name: "fallback-actual-smaller-limits", fallback: true },
  { name: "settled-fallback-mode-survives-overflow", streaming: true, modeFallback: true },
]

const serve = async (scenario) => {
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const route = request.url.split("/")[1]
      const seed = JSON.stringify(body.messages).includes("Seed the earlier checkpoint.") && !JSON.stringify(body.messages).includes("Recover the checkpoint.")
      const call = { route, path: request.url, body, seed }
      requests.push(call)
      response.setHeader("request-id", "req_overflow_fixture")
      const json = (status, value) => { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)) }
      const sse = (events) => { response.setHeader("content-type", "text/event-stream"); response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")) }
      const success = (content, stop = "end_turn") => body.stream ? sse(eventsFor(content, stop)) : json(200, message(stop, content))
      if (route === "summary") { success([{ type: "text", text: summary }]); return }
      if (seed) { success([{ type: "text", text: older }]); return }
      const active = requests.filter((row) => !row.seed && row.route !== "summary")
      const hasResult = body.messages.some((entry) => entry.content?.some?.((part) => part.type === "tool_result" && part.tool_use_id === toolId))
      if (hasResult) { success([{ type: "text", text: "Recovered checkpoint complete." }]); return }
      if (scenario.fallback && route === "primary") { json(503, { type: "error", error: { type: "overloaded_error", message: "Primary fixture unavailable." } }); return }
      if (scenario.modeFallback && active.length === 1) { sse([errorEvent("overloaded_error", "Fixture stream temporarily unavailable.")]); return }
      const attempts = active.filter((row) => !scenario.fallback || row.route === "fallback")
      const first = scenario.modeFallback ? attempts.length === 2 : attempts.length === 1
      if (first || scenario.repeat) {
        if (scenario.http) { const error = contextError(); json(scenario.http, { ...error, error: { ...error.error, ...(scenario.http === 413 ? { code: "context_length_exceeded" } : {}) } }); return }
        if (body.stream) { sse([start(), ...(scenario.late ? textEvents(visible) : []), contextError()]); return }
        json(200, message("model_context_window_exceeded", [tool])); return
      }
      success([tool], "tool_use")
    })
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  return { requests, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections()
  }) }
}

const runCase = async (scenario, index) => {
  const server = await serve(scenario)
  const workspace = await mkdtemp(join(tmpdir(), "efferent-overflow-")).catch(async (error) => { await server.close(); throw error })
  try {
    const report = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const context = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "process" } }).pipe(
        Layer.provideMerge(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
      ))
      const sessions = Context.get(context, Sessions)
      const address = { id: ConversationId.make(`00000000-0000-4000-8000-${String(20000 + index).padStart(12, "0")}`), owner: "overflow-fixture" }
      yield* sessions.create(address)
      const signals = []
      const observedSummary = definePlugin({
        id: "consumer/overflow-summary", version: "1", scope: "runtime",
        config: MemorySummaryConfig, defaults: memorySummaryDefaults, optional: [UtilityLlm], provides: [ConversationMemory],
        layer: (config) => Layer.effect(ConversationMemory, Effect.gen(function* () {
          const built = yield* memorySummaryPlugin.build(config, Context.empty())
          const base = Context.get(built, ConversationMemory)
          return ConversationMemory.of({ strategy: base.strategy, open: (scope) => base.open(scope).pipe(Effect.map((memory) => ({
            ...memory, maintain: (signal) => Effect.sync(() => signals.push({ runId: scope.runId, ...signal })).pipe(Effect.andThen(memory.maintain(signal))),
          }))) })
        })),
      })
      const handlers = yield* Ref.make(0)
      const published = []
      const modelDecisions = []
      const stepDecisions = []
      const agent = yield* Agent.define({
        plugins: [observedSummary, toolDiscoveryPlugin, stepLoopPlugin, { plugin: modelsPlugin, options: {
          storage: "memory", inheritPrevious: false, model: `gateway:${model}`, fastModel: `summary:${model}`,
          ...(scenario.fallback ? { fallbackModel: `backup:${model}` } : {}),
          endpoints: Object.fromEntries([["gateway", "primary"], ["backup", "fallback"], ["summary", "summary"]].map(([name, path]) => [name, {
            api: "anthropic-messages", url: `${server.origin}/${path}/v1`, apiKey: Redacted.make(placeholder),
          }])),
          modelSettings: {
            [`gateway:${model}`]: { limits: { contextWindow: 20_000, maxOutputTokens: 128 } },
            [`backup:${model}`]: { limits: { contextWindow: 2_500, maxOutputTokens: 128 } },
            [`summary:${model}`]: { limits: { maxOutputTokens: 128 } },
          },
        } }],
        capabilities: [defineCapability({ id: "overflow-fixture", version: "1",
          tools: [defineTool({ tool: Probe, handler: () => Effect.gen(function* () {
            yield* Ref.update(handlers, (count) => count + 1)
            const states = yield* toolCallStatesOf(yield* sessions.read(address))
            assert.equal(states.filter((state) => state.toolCallId === toolId && state._tag === "Started").length, 1, "tool ran before durable admission")
            return "The overflow checkpoint was recorded."
          }), annotations: { readOnly: true } })],
          skills: [defineSkill({ id: "overflow-fixture", summary: "Use the overflow fixture checkpoint.", always: true, tools: [Probe.name] })],
        })], workspace, budgetTokens: 12_000, system: "Preserve the overflow checkpoint.", limits: { streaming: scenario.streaming === true, maxSteps: 3 },
      })
      const policy = { ...modelRetryDefaults, maxAttempts: scenario.fallback ? 2 : 1, backoff: { initialMs: 0, maxMs: 0, jitter: 0 } }
      const invoke = (seed) => agent.turn({
        turn: { session: address, runId: RunId.make(`overflow-${scenario.name}-${seed ? "seed" : "active"}`), userMessage: new UserMessage({ text: seed ? "Seed the earlier checkpoint." : "Recover the checkpoint." }) },
        services: Context.make(Sessions, sessions),
      }, (turn) => Effect.gen(function* () {
        yield* turn.events.subscribe((event) => Option.some(event), (event) => Effect.sync(() => { if (!seed) published.push(event) }))
        yield* turn.tools.select(turn.userMessage)
        const done = yield* turn.run(seed ? {} : {
          stepContext: "tail",
          model: (info) => Effect.sync(() => { modelDecisions.push(info.stepIndex); return Option.none() }),
          step: (info) => Effect.sync(() => { stepDecisions.push(info.stepIndex); return { context: Option.some(`Overflow volatile checkpoint ${info.stepIndex}.`), toolChoice: Option.none() } }),
        }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy))
        return { outcome: done.outcome, reply: Option.some(done.text) }
      }))
      if (!scenario.irreducible) yield* invoke(true)
      const result = yield* Effect.result(invoke(false))
      if (result._tag === "Failure") assert.equal(Option.getOrElse(harnessCodeOf(result.failure), () => result.failure._tag), "model.context-overflow", `${scenario.name}: fixture failed before reaching semantic overflow`)
      assert.equal(result._tag, scenario.fails ? "Failure" : "Success", `${scenario.name}: overflow recovery result changed`)
      if (scenario.fails) assert.equal(Option.getOrElse(harnessCodeOf(result.failure), () => result.failure._tag), "model.context-overflow", "original overflow failure was replaced")
      const activeTurn = scenario.irreducible ? 1 : 2
      const events = yield* sessions.read(address)
      yield* Effect.forEach(events, (event) => Option.match(journalSchemaOf(event.kind), {
        onNone: () => Effect.die(`unknown journal kind ${event.kind}`), onSome: (schema) => Schema.decodeUnknownEffect(schema)(event.data),
      }), { concurrency: 1, discard: true })
      const headers = (yield* readStored("request.prepared", events)).filter(({ event }) => event.turn.value === activeTurn)
      const calls = yield* turnModelCallsOf(events, activeTurn)
      const active = server.requests.filter((row) => !row.seed && row.route !== "summary")
      const helper = server.requests.filter((row) => row.route === "summary")
      const expectedHeaders = scenario.repeat ? 2 : scenario.fails ? 1 : 3
      const expectedLoopCalls = scenario.fallback ? 5 : scenario.modeFallback ? 4 : expectedHeaders
      assert.equal(active.length, expectedLoopCalls, `${scenario.name}: wrong number of physical loop calls`)
      assert.equal(headers.length, expectedHeaders, "retry did not create exactly one fresh same-step header")
      assert.equal(helper.length, scenario.late || scenario.irreducible ? 0 : 1, "overflow maintenance was repeated or skipped")
      assert.equal(yield* Ref.get(handlers), scenario.fails ? 0 : 1, "failed overflow admitted tools or accepted retry ran twice")
      assert.equal(published.filter((event) => event._tag === "tool.started").length, scenario.fails ? 0 : 1)
      assert.deepEqual(modelDecisions, scenario.fails ? [0] : [0, 1], "recovery reevaluated model policy")
      assert.deepEqual(stepDecisions, modelDecisions, "recovery reevaluated StepContext")
      const memoryEntries = yield* entriesOfEvents(events)
      assert.equal(memoryEntries.filter((entry) => entry.turn === activeTurn && entry.body._tag === "StepContext").length, scenario.fails ? 1 : 2, "retry wrote another StepContext")
      assert.equal(memoryEntries.filter((entry) => entry.turn === activeTurn && entry.body._tag === "ToolResult").length, scenario.fails ? 0 : 1, "overflow response recorded an unaccepted tool result")
      if (scenario.fails) assert.equal(memoryEntries.filter((entry) => entry.turn === activeTurn && entry.body._tag === "Message" && entry.body.message.role === "assistant").length, 0, "failed overflow persisted an incomplete assistant response")
      const replayed = yield* Effect.forEach(headers, ({ event, data }) => replayModelRequest(events.filter((row) => row.seq <= event.seq), data.runId, data.step, data.run), { concurrency: 1 })
      if (headers.length > 1) {
        const rejected = headers[0].data
        const reduced = headers[1].data
        for (const field of ["system", "tools", "toolChoice", "model", "cacheKey", "callPolicy"]) assert.deepEqual(reduced[field], rejected[field], `retry changed ${field}`)
        assert.equal(reduced.step, rejected.step)
        assert.notDeepEqual(reduced.through, rejected.through, "retry reused the rejected memory cut")
        assert.ok(JSON.stringify(replayed[0].prompt.content).includes(older), "the rejected request did not include seeded evidence")
        assert.ok(JSON.stringify(replayed[1].prompt.content).includes(summary), "retry replay omitted the summary")
        assert.ok(!JSON.stringify(replayed[1].prompt.content).includes(older), "retry replay retained the old history")
        const attempted = active.filter((row) => row.route === (scenario.fallback ? "fallback" : "primary"))
        const rejectedBody = attempted[scenario.modeFallback ? 1 : 0].body
        const reducedBody = attempted[scenario.modeFallback ? 2 : 1].body
        assert.ok(JSON.stringify(reducedBody.messages).length < JSON.stringify(rejectedBody.messages).length, "actual HTTP retry did not reduce messages")
        for (const field of ["system", "tools", "tool_choice", "max_tokens"]) assert.deepEqual(reducedBody[field], rejectedBody[field], `actual retry changed ${field}`)
        assert.ok(JSON.stringify(reducedBody.messages).includes(summary))
        assert.equal(JSON.stringify(reducedBody.messages).split("Overflow volatile checkpoint 0.").length - 1, 1, "retry duplicated its volatile tail")
      }
      assert.equal(calls.length, active.length + helper.length, "physical sends were lost from the billing ledger")
      assert.equal(new Set(calls.map((call) => `${call.callId}:${call.attempt}`)).size, calls.length, "a physical call was billed twice")
      assert.equal(calls.filter((call) => call.purpose === "Helper").length, helper.length)
      assert.equal(calls.filter((call) => call.purpose === "Loop" && call.outcome._tag === "Failed").length, scenario.fallback ? 3 : scenario.modeFallback || scenario.repeat ? 2 : 1)
      const failedOverflow = calls.filter((call) => call.purpose === "Loop" && call.outcome._tag === "Failed" && Option.contains(call.outcome.failure, "ContextOverflow"))
      assert.equal(failedOverflow.length, scenario.repeat ? 2 : 1, "overflow facts lost their semantic failure")
      assert.ok(failedOverflow.every((call) => call.usage._tag === (scenario.http ? "Unknown" : scenario.streaming && !scenario.modeFallback ? "Partial" : "Known")), "recovery changed failed usage precision")
      const billed = yield* turnBilledUsageOf(events, activeTurn)
      const expectedBilled = scenario.late ? 101 : scenario.irreducible ? 108 : scenario.repeat ? 324 : scenario.http ? 324 : scenario.streaming && !scenario.modeFallback ? 425 : 432
      assert.equal(billed.totalTokens, expectedBilled, "failed/helper usage was lost or counted twice")
      if (!scenario.fails) assert.equal(result.success.usage.totalTokens, 216, "failed/helper response entered selected usage")
      assert.equal(published.filter((event) => event._tag === "stream.fallback").length, scenario.modeFallback ? 1 : 0)
      if (scenario.late) assert.ok(published.some((event) => event._tag === "assistant.delta" && event.delta === visible), "late overflow hid already visible text")
      if (scenario.modeFallback) assert.deepEqual(active.map((row) => row.body.stream === true), [true, false, false, false], "overflow reopened the rejected streaming mode")
      const overflow = signals.filter((signal) => signal.phase === "overflow")
      assert.equal(overflow.length, scenario.late ? 0 : 1, "the recovery allowance was not claimed exactly once")
      if (scenario.fallback) {
        const failed = published.find((event) => event._tag === "context.built" && event.step === 0)
        assert.ok(overflow[0].budgetTokens <= Math.floor(0.8 * (2_500 - 128 - failed.reservedTokens)), "fallback recovery used primary limits or invented output capacity")
        assert.deepEqual(calls.filter((call) => call.purpose === "Loop").map((call) => Option.getOrThrow(call.model).provider), ["gateway", "backup", "gateway", "backup", "gateway"])
        const groups = Map.groupBy(calls.filter((call) => call.purpose === "Loop"), (call) => call.callId)
        assert.deepEqual([...groups.values()].map((group) => group.map((call) => call.attempt)), [[1, 2], [1, 2], [1]], "context resend reused a transport retry budget")
      }
      assert.ok(!JSON.stringify(events).includes(placeholder), "credential entered the journal")
      return { name: scenario.name, calls: active.length, helpers: helper.length, headers: headers.length, handlers: yield* Ref.get(handlers), recoveryVerified: true, replayVerified: true, accountingVerified: true }
    })).pipe(Effect.timeout("8 seconds")))
    assert.deepEqual(await readdir(workspace), [], "memory configuration wrote fixture files")
    return report
  } finally { await server.close(); await rm(workspace, { recursive: true, force: true }) }
}

const watchdog = setTimeout(() => { console.error("the context-overflow fixture timed out"); process.exit(2) }, 90_000)
watchdog.unref()
try {
  const selected = process.argv.find((argument) => argument.startsWith("--case="))?.slice(7)
  const reports = []
  for (const [index, scenario] of cases.entries()) if (selected === undefined || selected === scenario.name) reports.push(await runCase(scenario, index))
  assert.ok(reports.length > 0, "no context-overflow fixture case selected")
  console.log(`context-overflow ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", reports })}`)
} finally { clearTimeout(watchdog) }
