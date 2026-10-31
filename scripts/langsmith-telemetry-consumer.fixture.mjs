/** Local OTLP evidence only: live LangSmith ingestion remains unverified. Shared by source Bun and packed Node/Bun. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Logger, Option, Redacted, Schema, Stream, Tracer } from "effect"
import { LanguageModel, Tool } from "effect/ai"
import {
  ConversationId, CurrentTraceContent, defineCapability, defineSkill, defineTool, Failure, InboxItemId, RunId,
  SessionLog, SessionLogMemoryLive, Sessions, TaskActivity, TaskExecutor, TaskQuestionId, TaskRunner, Tasks,
  TurnAdmissionOpen, UserMessage, UtilityLlm,
} from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { CurrentModelRetryPolicy, modelRetryDefaults, modelsPlugin, SettingsStore } from "@xandreed/plugin-models"
import { SessionLogFilesLive } from "@xandreed/plugin-session-files"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive, TaskStarted, TasksLive, tasksCapability, tasksDefaults } from "@xandreed/plugin-tasks"
import { flushTelemetry, LangSmithTelemetryLive } from "@xandreed/plugin-telemetry"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent, agentTaskExecutor } from "@xandreed/sdk"

const self = fileURLToPath(import.meta.url)
const mode = process.argv[2] ?? "all"
const usage = { inputTokens: { total: 7, uncached: 4, cacheRead: 2, cacheWrite: 1 }, outputTokens: { total: 2, reasoning: 1 } }
const finish = (reason = "stop") => ({ type: "finish", reason, usage })
const textParts = (text = "fixture-output") => [{ type: "text", text }, finish()]
const valueOf = (value) => value.stringValue ?? value.intValue ?? value.doubleValue ?? value.boolValue
const attrs = (span) => Object.fromEntries((span.attributes ?? []).map((entry) => [entry.key, valueOf(entry.value)]))
const spansOf = (posts) => posts.flatMap((post) => post.body.resourceSpans ?? []).flatMap((resource) => resource.scopeSpans).flatMap((scope) => scope.spans)
const nativeNames = new Set(["LanguageModel.generateText", "LanguageModel.generateObject", "LanguageModel.streamText"])
const kind = (span) => attrs(span)["langsmith.span.kind"]
const inference = (spans) => spans.filter((span) => kind(span) === "llm")
const usageKeys = (span) => Object.keys(attrs(span)).filter((key) => ["gen_ai.usage.", "gen_ai.cost.", "llm.usage.", "llm.token_count.", "llm.cost.", "langsmith.usage.", "langsmith.cost."].some((prefix) => key.startsWith(prefix)) || key === "usage_metadata" || key === "langsmith.usage_metadata")
const knownTotal = (spans, key) => inference(spans).reduce((total, span) => total + Number(attrs(span)[key] ?? 0), 0)
const descendants = (spans, name) => {
  const byId = new Map(spans.map((span) => [span.spanId, span]))
  return spans.filter((span) => {
    let parent = span
    while (parent) { if (parent.name === name) return true; parent = byId.get(parent.parentSpanId) }
    return false
  })
}
const report = (value) => console.log(`result ${JSON.stringify({ runtime: typeof Bun === "undefined" ? `Node ${process.versions.node}` : `Bun ${Bun.version}`, ...value })}`)

const serve = async () => {
  const posts = []
  const providerCalls = []
  const paths = []
  const server = createServer((request, response) => {
    paths.push(request.url)
    const chunks = []
    let bytes = 0
    request.on("data", (chunk) => { bytes += chunk.length; if (bytes > 2_097_152) request.destroy(); else chunks.push(chunk) })
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      response.setHeader("content-type", "application/json")
      if (request.url === "/traces") {
        posts.push({ headers: request.headers, body })
        response.end("{}")
      } else if (request.url === "/compat/v1/chat/completions") {
        providerCalls.push(body.model)
        if (body.model === "primary") { response.statusCode = 503; response.end(JSON.stringify({ error: { message: "fixture unavailable", type: "server_error" } })) }
        else response.end(JSON.stringify({ model: body.model, choices: [{ finish_reason: "stop", message: { content: `routed ${body.model}` } }], ...(body.model === "unknown" ? {} : { usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } }) }))
      } else { response.statusCode = 404; response.end("{}") }
    })
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  return { posts, providerCalls, paths, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}

/** This is explicit provider-author evidence on its native operation span, never reconstructed aggregate usage. */
const annotateKnown = (span, model = "fixture-native") => {
  Object.entries({ "gen_ai.operation.name": "chat", "gen_ai.provider.name": "fixture", "gen_ai.request.model": model, "gen_ai.response.model": model,
    "gen_ai.usage.input_tokens": 7, "gen_ai.usage.output_tokens": 2, "gen_ai.usage.cache_read.input_tokens": 2,
    "gen_ai.usage.cache_creation.input_tokens": 99, "gen_ai.usage.cache_write.input_tokens": 1, "gen_ai.usage.reasoning.output_tokens": 1,
  }).forEach(([key, value]) => span.attribute(key, value))
}
const authored = (options = {}) => LanguageModel.make({
  generateText: (request) => Effect.gen(function* () {
    options.reads?.push(yield* Effect.service(CurrentTraceContent))
    annotateKnown(request.span, options.model)
    return textParts(options.object ? '{"ok":true}' : options.text)
  }),
  streamText: (request) => options.failStream ? Stream.die("fixture stream unavailable") : Stream.unwrap(Effect.sync(() => {
    annotateKnown(request.span, options.model)
    return Stream.fromIterable([{ type: "text-start", id: "s" }, { type: "text-delta", id: "s", delta: "streamed fixture" }, { type: "text-end", id: "s" }, finish()])
  })),
})
const openSessions = (log = SessionLogMemoryLive) => Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(log, TurnAdmissionOpen)))).pipe(Effect.map(Context.get(Sessions)))
const toEnd = (policy = {}) => (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run(policy)), Effect.map((result) => ({ outcome: result.outcome, reply: result.outcome === "waiting" ? Option.none() : Option.some(result.text) })))
const runCase = (name, program) => program.pipe(Effect.withSpan(`case.${name}`))

const collector = async () => {
  const server = await serve()
  try {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const native = yield* authored({ object: true })
      yield* runCase("native", Effect.gen(function* () {
        assert.equal((yield* native.generateText({ prompt: "native text" })).text, '{"ok":true}')
        assert.deepEqual((yield* native.generateObject({ prompt: "native object", schema: Schema.Struct({ ok: Schema.Boolean }) })).value, { ok: true })
        yield* Stream.runDrain(native.streamText({ prompt: "native stream" }))
      }))
      const plain = yield* LanguageModel.make({ generateText: () => Effect.succeed(textParts("opaque usage")), streamText: () => Stream.die("not scripted") })
      const opaque = yield* runCase("opaque", plain.generateText({ prompt: "usage must stay unknown on the span" }))
      assert.equal(opaque.usage.inputTokens.total, 7)
      yield* runCase("explicit", native.generateText({ prompt: "explicit host inference" }).pipe(Effect.withSpan("host.explicit", { attributes: {
        "langsmith.span.kind": "llm", "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 7, "gen_ai.usage.output_tokens": 2,
      } })))

      const sessions = yield* openSessions()
      const reads = []
      const model = yield* authored({ reads, text: "private-consent-output" })
      const cases = [["consent-off", undefined, {}], ["consent-on", true, {}], ["consent-override", true, { captureTraceContent: false }]]
      for (const [name, captureTraceContent, policy] of cases) {
        const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 2 }, ...(captureTraceContent === undefined ? {} : { captureTraceContent }) })
        const view = yield* sessions.create({ owner: "langsmith-fixture" })
        yield* runCase(name, agent.turn({ turn: { session: { id: view.header.id, owner: "langsmith-fixture" }, runId: RunId.make(name), userMessage: new UserMessage({ text: "private-consent-input" }) }, services: Context.make(LanguageModel.LanguageModel, model).pipe(Context.add(Sessions, sessions)) }, toEnd(policy)))
      }

      const Inspect = Tool.make("inspect_fixture", { description: "Inspect fixture data.", parameters: Schema.Struct({}), success: Schema.String, failure: Failure, failureMode: "return" })
      const capability = defineCapability({ id: "fixture/inspect", version: "1", tools: [defineTool({ tool: Inspect, handler: () => Effect.succeed("fixture inspected") })], skills: [defineSkill({ id: "fixture.inspect", summary: "Inspect fixture data.", tools: [Inspect.name], always: true })] })
      const planned = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], capabilities: [capability], turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 3 } })
      const plannedSession = yield* sessions.create({ owner: "langsmith-fixture" })
      yield* runCase("planned", planned.turn({ turn: { session: { id: plannedSession.header.id, owner: "langsmith-fixture" }, runId: RunId.make("planned"), userMessage: new UserMessage({ text: "inspect" }) }, services: Context.make(LanguageModel.LanguageModel, native).pipe(Context.add(Sessions, sessions)) }, toEnd({ initial: { skills: [], calls: [{ name: Inspect.name, params: {} }] } })))

      const fallback = yield* authored({ failStream: true })
      const streamingAgent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], turnServices: [LanguageModel.LanguageModel], limits: { streaming: true, maxSteps: 2 } })
      const streamSession = yield* sessions.create({ owner: "langsmith-fixture" })
      yield* runCase("stream-fallback", streamingAgent.turn({ turn: { session: { id: streamSession.header.id, owner: "langsmith-fixture" }, runId: RunId.make("stream-fallback"), userMessage: new UserMessage({ text: "stream then fallback" }) }, services: Context.make(LanguageModel.LanguageModel, fallback).pipe(Context.add(Sessions, sessions)) }, toEnd()))

      const routed = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: modelsPlugin, options: {
        storage: "memory", model: "fixture:primary", fallbackModel: "fixture:fallback", fastModel: "fixture:helper", inheritPrevious: false,
        endpoints: { fixture: { url: `${server.url}/compat/v1` } }, credentials: { fixture: { type: "api_key", key: Redacted.make("fixture-local-provider-key") } },
      } }], limits: { streaming: false, maxSteps: 2 } })
      const routeSession = yield* sessions.create({ owner: "langsmith-fixture" })
      const routedResult = yield* runCase("routed-helper", routed.turn({ turn: { session: { id: routeSession.header.id, owner: "langsmith-fixture" }, runId: RunId.make("routed-helper"), userMessage: new UserMessage({ text: "route locally" }) }, services: Context.make(Sessions, sessions) }, (turn) => Effect.gen(function* () {
        const result = yield* toEnd()(turn)
        assert.equal((yield* (yield* UtilityLlm).complete("local helper")).text, "routed helper")
        yield* (yield* SettingsStore).setRole("general", Option.some("fixture:unknown"))
        return result
      })).pipe(Effect.provideService(CurrentModelRetryPolicy, { ...modelRetryDefaults, maxAttempts: 2, requestTimeoutMs: 5000, bodyIdleTimeoutMs: 5000, totalTimeoutMs: 10000, backoff: { initialMs: 0, maxMs: 0, jitter: 0 } })))
      assert.equal(routedResult.usage.totalTokens, 9)
      const unknownSession = yield* sessions.create({ owner: "langsmith-fixture" })
      yield* runCase("routed-unknown", routed.turn({ turn: { session: { id: unknownSession.header.id, owner: "langsmith-fixture" }, runId: RunId.make("routed-unknown"), userMessage: new UserMessage({ text: "usage is omitted by this provider" }) }, services: Context.make(Sessions, sessions) }, toEnd()))
      yield* flushTelemetry
      return { posts: [...server.posts], reads }
    })).pipe(Effect.provide(LangSmithTelemetryLive({ apiKey: Redacted.make("fixture-collector-key"), target: { _tag: "Project", project: "fixture" }, serviceName: "langsmith-fixture", tracesUrl: `${server.url}/traces`, protocol: "http/json", exportInterval: "1 hour", shutdownTimeout: "5 seconds" })), Effect.provide(Logger.layer([]))))

    assert.ok(observed.posts.length > 0)
    assert.ok(observed.posts.every((post) => post.headers["x-api-key"] === "fixture-collector-key" && post.headers["langsmith-project"] === "fixture" && post.headers["langsmith-agent-id"] === undefined))
    assert.ok(server.paths.every((path) => path === "/traces" || path === "/compat/v1/chat/completions"), "trace binding emitted an unexpected metrics/other request")
    const spans = spansOf(observed.posts)
    const native = descendants(spans, "case.native").filter((span) => nativeNames.has(span.name))
    assert.deepEqual(native.map((span) => span.name).sort(), [...nativeNames].sort())
    assert.ok(native.every((span) => kind(span) === "llm"))
    assert.equal(knownTotal(native, "gen_ai.usage.input_tokens"), 21)
    assert.equal(knownTotal(native, "gen_ai.usage.output_tokens"), 6)
    assert.ok(native.every((span) => Number(attrs(span)["gen_ai.usage.cache_write.input_tokens"]) === 1 && attrs(span)["gen_ai.system"] === "fixture"))
    const opaque = descendants(spans, "case.opaque").filter((span) => nativeNames.has(span.name))
    assert.equal(opaque.length, 1)
    assert.equal(kind(opaque[0]), "llm")
    assert.deepEqual(usageKeys(opaque[0]), [], "plain LanguageModel.make usage was inferred instead of remaining unknown")
    const explicit = descendants(spans, "case.explicit")
    assert.equal(inference(explicit).length, 1)
    assert.equal(inference(explicit)[0].name, "host.explicit")
    assert.equal(knownTotal(explicit, "gen_ai.usage.input_tokens"), 7)
    assert.deepEqual(observed.reads, [false, true, false])
    for (const name of ["consent-off", "consent-override"]) assert.ok(!JSON.stringify(descendants(spans, `case.${name}`)).includes("private-consent-"), `${name} exported private content`)
    const consent = descendants(spans, "case.consent-on")
    assert.ok(consent.some((span) => String(attrs(span)["input.value"] ?? "").includes("private-consent-input")))
    assert.ok(consent.some((span) => String(attrs(span)["output.value"] ?? "").includes("private-consent-output")))
    const planned = descendants(spans, "case.planned")
    assert.equal(planned.filter((span) => nativeNames.has(span.name)).length, 2)
    assert.equal(inference(planned).length, 1, "planned host tools were billed as another inference")
    assert.equal(knownTotal(planned, "gen_ai.usage.input_tokens"), 7)
    const tool = planned.filter((span) => span.name === "tool.inspect_fixture")
    assert.equal(tool.length, 1)
    assert.equal(kind(tool[0]), "tool")
    assert.equal(attrs(tool[0])["gen_ai.operation.name"], "execute_tool")
    assert.equal(attrs(tool[0])["gen_ai.tool.name"], "inspect_fixture")
    assert.equal(typeof attrs(tool[0])["efferent.invocation.id"], "string")
    assert.equal(typeof attrs(tool[0])["efferent.tool.call.id"], "string")
    assert.equal(attrs(tool[0])["gen_ai.tool.call.id"], undefined, "a minted planned id was presented as provider-authored")
    assert.ok(planned.filter((span) => span.name === "loop.tool_call").every((span) => kind(span) === "chain"))
    const fallback = descendants(spans, "case.stream-fallback")
    assert.deepEqual(fallback.filter((span) => nativeNames.has(span.name)).map((span) => span.name).sort(), ["LanguageModel.generateText", "LanguageModel.streamText"])
    assert.equal(inference(fallback).length, 2)
    assert.equal(knownTotal(fallback, "gen_ai.usage.input_tokens"), 7)
    const routed = descendants(spans, "case.routed-helper")
    assert.deepEqual(server.providerCalls, ["primary", "fallback", "helper", "unknown"])
    assert.equal(routed.filter((span) => nativeNames.has(span.name)).length, 3)
    assert.equal(inference(routed).length, 3)
    assert.equal(routed.filter((span) => span.name === "models.utility").length, 1)
    const routedNative = routed.filter((span) => nativeNames.has(span.name))
    assert.deepEqual(routedNative.map((span) => attrs(span)["gen_ai.request.model"]), ["primary", "fallback", "helper"])
    assert.ok(routedNative.every((span) => attrs(span)["gen_ai.provider.name"] === "fixture" && attrs(span)["gen_ai.response.model"] === undefined))
    assert.deepEqual(usageKeys(routedNative[0]), [], "failed primary acquired usage from its fallback")
    assert.equal(knownTotal(routed, "gen_ai.usage.input_tokens"), 14)
    assert.equal(knownTotal(routed, "gen_ai.usage.output_tokens"), 4)
    const unknownRoute = descendants(spans, "case.routed-unknown").filter((span) => nativeNames.has(span.name))
    assert.equal(unknownRoute.length, 1)
    assert.equal(kind(unknownRoute[0]), "llm")
    assert.equal(attrs(unknownRoute[0])["gen_ai.request.model"], "unknown")
    assert.deepEqual(usageKeys(unknownRoute[0]), [], "missing compat usage became Known(0) or selected aggregate usage")
    assert.ok(spans.filter((span) => kind(span) === "chain").every((span) => usageKeys(span).length === 0), "an aggregate wrapper retained inference usage/cost aliases")
    return { localCollectorVerified: true, liveLangSmithIngestionVerified: false, nativeTextObjectStreamOnce: true, opaqueUsageUnknown: true, explicitBoundaryOnce: true, contentConsentVerified: true, plannedToolNotInference: true, streamFallbackNoDoubleUsage: true, routedHelperNoDoubleUsage: true, routedCompatReportedUsage: true, omittedProviderUsageUnknown: true }
  } finally { await server.close() }
}

const parent = { owner: "trace-parent-fixture", id: ConversationId.make("00000000-0000-4000-8000-000000003100") }
const taskId = ConversationId.make("00000000-0000-4000-8000-000000003110")
const child = { id: taskId, owner: parent.owner }
const query = { after: 0, limit: Option.none(), kinds: [] }
const parentFor = (sampled) => Tracer.externalSpan({ traceId: sampled ? "1".repeat(32) : "2".repeat(32), spanId: "3".repeat(16), sampled })
const unrelated = Tracer.externalSpan({ traceId: "9".repeat(32), spanId: "8".repeat(16), sampled: true })
const taskRecords = (sessions) => sessions.read(parent, { kinds: ["task.started"] }).pipe(Effect.flatMap((rows) => Schema.decodeUnknownEffect(TaskStarted)(rows[0].data)))
const files = (directory) => SessionLogFilesLive(join(directory, "sessions"))

const produce = (directory, sampled) => Effect.scoped(Effect.gen(function* () {
  const sessions = yield* openSessions(files(directory))
  yield* sessions.create(parent)
  const built = yield* Layer.build(TasksLive(tasksDefaults).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sessions, sessions), Layer.succeed(TaskRunner, { run: () => Effect.void }), Layer.succeed(TaskExecutor, { turn: () => Effect.die("producer must not execute"), react: () => Effect.void })))))
  const tasks = Context.get(built, Tasks)
  yield* tasks.start(parent, { taskId, instructions: "Ask which source, then inspect it.", mode: "spawn" }).pipe(Effect.withParentSpan(parentFor(sampled)))
  const first = yield* taskRecords(sessions)
  yield* tasks.start(parent, { taskId, instructions: first.instructions, mode: first.mode }).pipe(Effect.withParentSpan(unrelated))
  const repeated = yield* taskRecords(sessions)
  assert.deepEqual(first.traceParent, repeated.traceParent, "retry replaced the first committed trace parent")
  assert.equal(first.traceParent.traceId, parentFor(sampled).traceId)
  assert.equal(first.traceParent.sampled, sampled)
  assert.deepEqual(yield* sessions.read(child), [])
  return { traceParent: first.traceParent, producerNeverExecuted: true }
}))

const consume = (directory) => Effect.scoped(Effect.gen(function* () {
  const spans = []
  const capturing = Tracer.make({ span: (options) => { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
  return yield* Effect.gen(function* () {
    const sessions = yield* openSessions(files(directory))
    const stored = yield* taskRecords(sessions)
    let calls = 0
    const model = yield* LanguageModel.make({ generateText: () => Effect.sync(() => ++calls === 1
      ? [{ type: "tool-call", id: "trace-question", name: "ask_parent", params: { text: "Which source?" } }, finish("tool-calls")]
      : textParts("The source is inspected.")), streamText: () => Stream.die("not scripted") })
    const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], capabilities: [tasksCapability], turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 2 } })
    const executor = agentTaskExecutor(agent, { services: Context.make(LanguageModel.LanguageModel, model), react: (turn) => turn.reply("The task notice was received.") })
    const built = yield* Layer.build(TasksLive(tasksDefaults).pipe(Layer.provideMerge(Layer.mergeAll(Layer.succeed(Sessions, sessions), InProcessTaskRunnerLive(), executor))))
    const tasks = Context.get(built, Tasks)
    const idle = Context.get(built, TaskActivity).idle
    yield* tasks.reconcile(parent)
    yield* idle
    const waiting = yield* tasks.status(parent, taskId)
    assert.equal(waiting.status, "waiting")
    assert.equal(calls, 1)
    const drain = (id, runId) => Effect.scoped(Effect.gen(function* () {
      const writer = yield* sessions.begin(child, { _tag: "Queued", input: id, runId: RunId.make(runId) })
      const outcome = yield* tasks.execute(writer)
      yield* writer.end({ reason: outcome.outcome, failure: Option.none() })
      return outcome
    }))
    const stale = InboxItemId.make("trace-bookkeeping")
    yield* sessions.enqueue(child, { id: stale, userMessage: new UserMessage({ text: "A steer accepted before the question" }), delivery: "steer", source: {} })
    assert.equal((yield* drain(stale, "trace-bookkeeping")).outcome, "waiting")
    assert.equal(calls, 1)
    yield* tasks.answer(parent, taskId, { questionId: waiting.question.questionId, text: "Inspect the primary source." })
    const rows = yield* sessions.read(child)
    const input = rows.find((row) => row.kind === "task.answered").data.input
    assert.equal((yield* drain(input.id, "trace-followup")).outcome, "completed")
    yield* tasks.reconcile(parent)
    yield* idle
    assert.equal(calls, 2)
    const executions = spans.filter((span) => span.name === "task.run")
    assert.equal(executions.length, 2, "initial execution duplicated or bookkeeping gained an execution span")
    executions.forEach((span) => {
      assert.equal(span.traceId, stored.traceParent.traceId)
      assert.equal(span.parent.value.spanId, stored.traceParent.spanId)
      assert.equal(span.parent.value.traceId, stored.traceParent.traceId)
      assert.equal(span.sampled, stored.traceParent.sampled)
    })
    const byId = new Map(spans.map((span) => [span.spanId, span]))
    const nearestTask = (span) => { let at = Option.getOrUndefined(span.parent); while (at) { if (at.name === "task.run") return at; at = Option.getOrUndefined(byId.get(at.spanId)?.parent ?? Option.none()) } }
    const childTurns = spans.filter((span) => span.name === "agent.turn" && span.attributes.get("efferent.session.id") === child.id)
    assert.equal(childTurns.length, 2)
    childTurns.forEach((span) => { assert.ok(nearestTask(span), "actual child Agent.turn lost task.run ancestry"); assert.equal(span.traceId, stored.traceParent.traceId); assert.equal(span.sampled, stored.traceParent.sampled) })
    return { traceParent: stored.traceParent, executionParents: executions.map((span) => ({ traceId: span.traceId, parentSpanId: span.parent.value.spanId, sampled: span.sampled })), actualAgentChildren: 2, executions: 2, bookkeepingExecutions: 0, consumerCalls: calls }
  }).pipe(Effect.withParentSpan(unrelated), Effect.withTracer(capturing))
}))

const children = new Set()
const killChildren = () => children.forEach((child) => child.kill("SIGKILL"))
process.once("exit", killChildren)
const childProcess = async (args) => {
  const processChild = spawn(process.execPath, [self, ...args], { stdio: ["ignore", "pipe", "pipe"] })
  children.add(processChild)
  processChild.once("close", () => children.delete(processChild))
  let output = "", errors = ""
  processChild.stdout.setEncoding("utf8"); processChild.stderr.setEncoding("utf8")
  processChild.stdout.on("data", (chunk) => { output += chunk; if (Buffer.byteLength(output) > 1_048_576) processChild.kill("SIGKILL") })
  processChild.stderr.on("data", (chunk) => { errors += chunk; if (Buffer.byteLength(errors) > 1_048_576) processChild.kill("SIGKILL") })
  const timer = setTimeout(() => processChild.kill("SIGKILL"), 25_000)
  try {
    const code = await new Promise((resolve, reject) => { processChild.once("error", reject); processChild.once("close", (code) => resolve(code)) })
    assert.equal(code, 0, `${args[0]} failed: ${output}\n${errors}`)
    assert.equal(errors, "", `${args[0]} wrote diagnostics`)
    const line = output.split("\n").findLast((line) => line.startsWith("result "))
    assert.ok(line, `${args[0]} produced no evidence`)
    return JSON.parse(line.slice(7))
  } finally { clearTimeout(timer); processChild.kill("SIGKILL") }
}
const ancestry = async () => {
  const directory = await mkdtemp(join(tmpdir(), "efferent-task-trace-"))
  try {
    for (const sampled of [false, true]) {
      const root = join(directory, String(sampled))
      const produced = await childProcess(["produce", root, String(sampled)])
      const consumed = await childProcess(["consume", root])
      assert.deepEqual(consumed.traceParent, produced.traceParent)
      assert.equal(consumed.traceParent.sampled, sampled)
      assert.equal(consumed.executions, 2)
      assert.equal(consumed.bookkeepingExecutions, 0)
      assert.equal(consumed.actualAgentChildren, 2)
    }
    return { freshProcessTaskAncestry: true, sampledTrueAndFalsePreserved: true, firstCommittedParentWins: true, actualChildAgentAncestry: true, initialAndFollowupOnce: true, bookkeepingNoExecutionSpan: true }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

const main = async () => {
  if (mode === "produce") return Effect.runPromise(produce(process.argv[3], process.argv[4] === "true").pipe(Effect.provide(Logger.layer([]))))
  if (mode === "consume") return Effect.runPromise(consume(process.argv[3]).pipe(Effect.provide(Logger.layer([]))))
  if (mode === "collector") return collector()
  if (mode === "ancestry") return ancestry()
  assert.equal(mode, "all")
  return { ...await collector(), ...await ancestry() }
}
const watchdog = setTimeout(() => { console.error("langsmith fixture deadline"); process.exit(1) }, 80_000)
try { report(await main()) } finally { clearTimeout(watchdog); killChildren(); process.off("exit", killChildren) }
