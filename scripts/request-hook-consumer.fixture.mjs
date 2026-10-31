/** Real Agent/files request-hook evidence, shared by source Bun and packed Node/Bun. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Deferred, Effect, Fiber, Layer, Logger, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool } from "effect/ai"
import {
  canonicalJson, ConversationId, CurrentAgentRun, CurrentAgentStep, defineCapability,
  defineSkill, defineTool, describeModel, entriesOfEvents, Failure, harnessCodeOf,
  hostNote, journalSchemaOf, ModelRequestHook, readStored, replayModelRequest,
  resolveRequestHeader, RunId, RunOrdinal, SessionLog, SessionLogError, Sessions,
  STORED_FORMAT, toolCallStatesOf, TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import { toolParametersSchema } from "@xandreed/core/internal"
import { modelRequestHookConformance } from "@xandreed/core/conformance"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionLogFilesLive } from "@xandreed/plugin-session-files"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"

const self = fileURLToPath(import.meta.url)
const mode = process.argv[2] ?? "journey"
const directory = process.argv[3]
const owner = "request-hook-fixture"
const address = (index) => ({ owner, id: ConversationId.make(`00000000-0000-4000-8000-0000000028${String(index).padStart(2, "0")}`) })
const targets = { tail: address(1), system: address(2), absent: address(3), empty: address(4), mutation: address(5), stream: address(6), held: address(7), before: address(8), lost: address(9), invalid: address(10) }
const query = { after: 0, limit: Option.none(), kinds: [] }
const finish = (reason = "stop") => ({ type: "finish", reason, usage: { inputTokens: { total: 4 }, outputTokens: { total: 1 } } })
const say = (text) => Effect.sync(() => process.stdout.write(`${text}\n`))
const done = (value) => say(`result ${JSON.stringify(value)}`)
const clone = (value) => JSON.parse(JSON.stringify(value))
const systemText = "Accepted request-hook system Ω."
const baseContext = (step) => `Policy context for step ${step}.`
const hookContext = (step) => `Accepted hook context for step ${step}.`
const combinedContext = (step) => `${baseContext(step)}\n\n${hostNote(hookContext(step))}`
const Probe = Tool.make("request_hook_probe", { description: "Return the request-hook fixture checkpoint.", parameters: Tool.EmptyParams, success: Schema.String, failure: Failure, failureMode: "return" })
const build = (root, decorate = (log) => log) => Effect.gen(function* () {
  const raw = Context.get(yield* Layer.build(SessionLogFilesLive(join(root, "sessions"))), SessionLog)
  const log = decorate(raw)
  const context = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 120_000, renew: "on-commit" } }).pipe(
    Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)),
  ))
  return { raw, log, sessions: Context.get(context, Sessions) }
})
const audit = (log, target) => Effect.gen(function* () {
  const events = yield* log.read(target.id, query)
  yield* Effect.forEach(events, (event) => Option.match(journalSchemaOf(event.kind), { onNone: () => Effect.die(`unknown journal kind ${event.kind}`), onSome: (schema) => Schema.decodeUnknownEffect(schema)(event.data) }), { concurrency: 1, discard: true })
  const headers = events.filter((event) => event.kind === "request.prepared")
  const materialized = yield* Effect.forEach(headers, (event) => Effect.gen(function* () {
    const prefix = events.slice(0, events.indexOf(event) + 1)
    const header = yield* resolveRequestHeader(prefix, { session: event.session, seq: event.seq })
    const request = yield* replayModelRequest(prefix, header.runId, header.step, header.run)
    return { event, header, request, prompt: yield* Schema.encodeEffect(Prompt.Prompt)(request.prompt) }
  }), { concurrency: 1 })
  const entries = yield* entriesOfEvents(events)
  const head = yield* log.head(target.id)
  assert.equal(head.state.sessions.format, STORED_FORMAT)
  return { events, headers, materialized, entries, head }
})
const compare = (state, observed) => {
  for (const actual of observed) {
    const stored = state.materialized.find(({ header }) => header.runId === actual.runId && header.run === actual.run && header.step === actual.step)
    assert.ok(stored, "actual model invocation has no durable prepared request")
    assert.deepEqual(stored.prompt, actual.prompt, "cold reconstruction differs from the actual model prompt")
    assert.deepEqual(stored.request.toolChoice, actual.toolChoice, "replay changed effective tool choice")
    assert.deepEqual(stored.request.tools.map(({ name, description, parameters }) => ({ name, description, parameters })), actual.tools)
  }
}
const runTurn = (sessions, target, runName, options = {}) => Effect.gen(function* () {
  const observed = options.observed ?? []
  const hookCalls = options.hookCalls ?? []
  const patches = options.patches ?? []
  const handlers = yield* Ref.make(0)
  const policyCalls = yield* Ref.make(0)
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [defineCapability({ id: "request-hook-fixture", version: "1", tools: [defineTool({ tool: Probe, annotations: { readOnly: true }, handler: () => Effect.gen(function* () {
      const states = yield* toolCallStatesOf(yield* sessions.read(target))
      assert.equal(states.filter((state) => state.toolCallId === `${runName}-call` && state._tag === "Started").length, 1)
      yield* Ref.update(handlers, (count) => count + 1)
      return "Request-hook checkpoint returned."
    }) })], skills: [defineSkill({ id: "request-hook-fixture", summary: "Use the request-hook fixture checkpoint.", always: true, tools: [Probe.name] })] })],
    system: "Original request-hook system.", turnServices: [LanguageModel.LanguageModel], limits: { streaming: options.streaming === true, maxSteps: 3 },
  })
  const hook = ModelRequestHook.of({ prepare: (draft) => Effect.gen(function* () {
    const run = yield* CurrentAgentRun
    const step = yield* CurrentAgentStep
    assert.ok(Option.isSome(run) && Option.isSome(step), "hook lost its actual run/step context")
    assert.deepEqual(run.value, draft.run)
    assert.equal(step.value, draft.step)
    assert.equal(draft.run.id, runName)
    assert.ok(Object.isFrozen(draft) && Object.isFrozen(draft.activeTools), "hook draft is not detached and frozen")
    hookCalls.push({ run: clone(draft.run), step: draft.step })
    if (options.throwingHook) return yield* Effect.die(new Error("historical replay invoked today's hook"))
    const patch = options.emptyHook ? {} : options.invalidHook ? { toolChoice: { tool: "inactive_hook_tool" } }
      : { system: systemText, context: hookContext(draft.step), toolChoice: options.single || draft.step > 0 ? null : { tool: Probe.name } }
    patches.push(patch)
    return patch
  }) })
  const capture = (method, call) => Effect.gen(function* () {
    const run = Option.getOrThrow(yield* CurrentAgentRun)
    const step = Option.getOrThrow(yield* CurrentAgentStep)
    const actual = { runId: run.id, run: run.ordinal, step, method, prompt: yield* Schema.encodeEffect(Prompt.Prompt)(call.prompt), tools: call.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: toolParametersSchema(tool) })), toolChoice: call.toolChoice }
    observed.push(actual)
    if (options.forbidCall) return yield* say("unexpected-model-send").pipe(Effect.andThen(Effect.die(new Error("a request dispatched before its ACK"))))
    return actual
  })
  const model = describeModel(yield* LanguageModel.make({
    generateText: (call) => capture("settled", call).pipe(Effect.map(() => options.single || observed.filter((value) => value.method === "settled").length > 1
      ? [{ type: "text", text: "Request-hook checkpoint complete." }, finish()]
      : [{ type: "tool-call", id: `${runName}-call`, name: Probe.name, params: {}, providerExecuted: false }, finish("tool-calls")])),
    streamText: (call) => Stream.unwrap(capture("stream", call).pipe(Effect.as(Stream.die(new Error("scripted precontent stream failure"))))),
  }), { provider: "fixture", model: "request-hook", settings: {} })
  const services = Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model))
  const result = yield* agent.turn({ turn: { session: target, runId: RunId.make(runName), key: runName, userMessage: new UserMessage({ text: options.userText ?? "Inspect the request-hook checkpoint." }), ...(options.resume ? { resumes: 1, takeOver: true } : {}) }, services: options.absentHook ? services : Context.add(services, ModelRequestHook, hook) }, (turn) => Effect.gen(function* () {
    yield* turn.tools.select(turn.userMessage)
    const response = yield* turn.run({ stepContext: options.placement ?? "tail", step: (info) => Ref.update(policyCalls, (count) => count + 1).pipe(Effect.as({ context: options.noContext ? Option.none() : Option.some(baseContext(info.stepIndex)), toolChoice: Option.some("required") })) })
    return { outcome: response.outcome, reply: Option.some(response.text) }
  }))
  return { result, observed, hookCalls, patches, handlers: yield* Ref.get(handlers), policyCalls: yield* Ref.get(policyCalls) }
})
const checkApplied = (state, result, placement, options = {}) => {
  assert.equal(result.hookCalls.length, options.hooks ?? result.observed.length, "the fresh request did not invoke its hook exactly once")
  compare(state, result.observed)
  for (const { event, header } of state.materialized.filter(({ header }) => header.runId === result.observed[0]?.runId)) {
    assert.equal(event.data.version, 2, "the actual Agent did not write V2 headers")
    const patch = options.single ? { system: systemText, context: hookContext(header.step), toolChoice: null }
      : { system: systemText, context: hookContext(header.step), toolChoice: header.step === 0 ? { tool: Probe.name } : null }
    assert.deepEqual(header.hook, patch, "materialized V1 lost the accepted normalized patch")
    assert.deepEqual(event.data.hook, patch, "stored V2 lost the accepted normalized patch")
    const contexts = state.entries.filter((entry) => entry.runId === header.runId && entry.body._tag === "StepContext" && entry.body.run === header.run && entry.step === header.step)
    assert.equal(contexts.length, 1, "a fresh request wrote duplicate policy/hook StepContexts")
    assert.equal(contexts[0].body.text, combinedContext(header.step))
    assert.equal(header.system, placement === "system" ? `${systemText}\n\n${combinedContext(header.step)}` : systemText)
  }
}
const save = (root, value) => Effect.tryPromise(() => writeFile(join(root, "captured.json"), JSON.stringify(value)))
const record = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw, sessions } = yield* build(root)
  const captured = []
  yield* Effect.forEach(["tail", "system"], (placement) => Effect.gen(function* () {
    const target = targets[placement]
    yield* sessions.create(target)
    const result = yield* runTurn(sessions, target, `hook-${placement}`, { placement })
    const state = yield* audit(raw, target)
    checkApplied(state, result, placement)
    assert.equal(result.handlers, 1)
    assert.equal(state.headers.length, 2)
    captured.push({ target, observed: result.observed })
  }), { concurrency: 1 })
  yield* save(root, captured)
  return { actualHookApplied: true, oneContext: true, placementsVerified: true, headerPatchVerified: true, materializedV1Verified: true, dispatchReplayVerified: true, calls: captured.reduce((total, run) => total + run.observed.length, 0), handlers: 2 }
}))

const coldReplay = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw } = yield* build(root)
  const captured = yield* Effect.tryPromise(() => readFile(join(root, "captured.json"), "utf8").then(JSON.parse))
  const calls = { count: 0 }
  const throwing = ModelRequestHook.of({ prepare: () => { calls.count++; return Effect.die(new Error("historical replay called today's hook")) } })
  yield* Effect.forEach(captured, ({ target, observed }) => Effect.gen(function* () {
    const before = yield* raw.head(target.id)
    const state = yield* audit(raw, target).pipe(Effect.provideService(ModelRequestHook, throwing))
    compare(state, observed)
    const after = yield* raw.head(target.id)
    assert.deepEqual([after.seq, after.revision], [before.seq, before.revision], "read-only cold replay wrote the journal")
  }), { concurrency: 1 })
  assert.equal(calls.count, 0)
  return { coldReplayHookSkipped: true, readOnlyReopenVerified: true, dispatchReplayVerified: true, hookCalls: calls.count }
}))
const mutation = (root) => Effect.scoped(Effect.gen(function* () {
  const entered = yield* Deferred.make()
  const release = yield* Deferred.make()
  const armed = yield* Ref.make(true)
  const patches = [], observed = []
  const { raw, sessions } = yield* build(root, (base) => SessionLog.of({ ...base, commit: (id, input) => Effect.gen(function* () {
    if (input.events.some((event) => event.kind === "memory.step") && (yield* Ref.getAndSet(armed, false))) {
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
    }
    return yield* base.commit(id, input)
  }) }))
  yield* sessions.create(targets.mutation)
  const running = yield* Effect.forkChild(runTurn(sessions, targets.mutation, "hook-mutation", { patches, observed }))
  return yield* Effect.gen(function* () {
    yield* Deferred.await(entered)
    assert.equal(observed.length, 0, "context ACK was not a dispatch boundary")
    assert.equal(patches.length, 1)
    patches[0].system = "MUTATED system"
    patches[0].context = "MUTATED context"
    patches[0].toolChoice.tool = "MUTATED inactive tool"
    yield* Deferred.succeed(release, undefined)
    const result = yield* Fiber.join(running)
    checkApplied(yield* audit(raw, targets.mutation), result, "tail")
    return { patchSnapshotVerified: true, oneContext: true, calls: observed.length }
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
}))
const controls = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw, sessions } = yield* build(root)
  const seen = []
  yield* Effect.forEach(["absent", "empty"], (kind) => Effect.gen(function* () {
    yield* sessions.create(targets[kind])
    const result = yield* runTurn(sessions, targets[kind], `hook-noop-${kind}`, { single: true, noContext: true, absentHook: kind === "absent", emptyHook: kind === "empty", userText: "Compare no-op request controls." })
    const state = yield* audit(raw, targets[kind])
    assert.equal(state.headers.length, 1)
    assert.equal(state.entries.filter((entry) => entry.body._tag === "StepContext").length, 0, "no-op hook fabricated an empty context")
    assert.equal(result.hookCalls.length, kind === "empty" ? 1 : 0)
    assert.equal(Object.hasOwn(state.materialized[0].header, "hook"), kind === "empty")
    if (kind === "empty") assert.deepEqual(state.materialized[0].header.hook, {})
    seen.push({ prompt: result.observed[0].prompt, tools: result.observed[0].tools, toolChoice: result.observed[0].toolChoice })
  }), { concurrency: 1 })
  assert.deepEqual(seen[0], seen[1], "empty-hook provenance changed model-visible bytes")
  yield* sessions.create(targets.stream)
  const streamed = yield* runTurn(sessions, targets.stream, "hook-stream", { streaming: true, single: true })
  const state = yield* audit(raw, targets.stream)
  assert.deepEqual(streamed.observed.map((call) => call.method), ["stream", "settled"])
  assert.equal(streamed.policyCalls, 1)
  assert.equal(streamed.hookCalls.length, 1)
  assert.equal(state.headers.length, 1)
  assert.deepEqual(streamed.observed[0].prompt, streamed.observed[1].prompt)
  assert.deepEqual(streamed.observed[0].toolChoice, streamed.observed[1].toolChoice)
  checkApplied(state, streamed, "tail", { hooks: 1, single: true })
  assert.equal(state.events.filter((event) => event.kind === "stream.fallback").length, 1)
  return { noOpCompatibilityVerified: true, streamFallbackFrozenReuse: true, physicalCalls: 2, headers: 1, hookCalls: 1 }
}))
const errors = (root) => Effect.scoped(Effect.gen(function* () {
  const evidence = []
  yield* Effect.forEach(["before", "lost", "invalid"], (kind) => Effect.gen(function* () {
    const original = new SessionLogError({ code: "fixture.header-ack", message: "the fixture request header acknowledgement failed" })
    const { raw, sessions } = yield* build(join(root, kind), (base) => SessionLog.of({ ...base, commit: (id, input) => {
      const selected = input.events.some((event) => event.kind === "request.prepared")
      if (selected && kind === "before") return Effect.fail(original)
      return base.commit(id, input).pipe(Effect.flatMap((answer) => selected && kind === "lost" ? Effect.fail(original) : Effect.succeed(answer)))
    } }))
    yield* sessions.create(targets[kind])
    const observed = [], hookCalls = []
    const result = yield* Effect.result(runTurn(sessions, targets[kind], `hook-error-${kind}`, { single: true, observed, hookCalls, invalidHook: kind === "invalid" }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set())))
    assert.equal(result._tag, "Failure", "a refused request dispatched")
    if (kind === "invalid") assert.equal(Option.getOrNull(harnessCodeOf(result.failure)), "request.hook")
    else assert.equal(result.failure, original, "writer failure was replaced by a hook failure")
    assert.equal(observed.length, 0)
    assert.equal(hookCalls.length, 1)
    const state = yield* audit(raw, targets[kind])
    assert.equal(state.headers.length, kind === "lost" ? 1 : 0)
    assert.equal(state.entries.filter((entry) => entry.body._tag === "ToolResult").length, 0)
    if (kind === "invalid") assert.equal(state.entries.filter((entry) => entry.body._tag === "StepContext").length, 0)
    evidence.push({ kind, calls: 0, headers: state.headers.length, originalError: kind === "invalid" || result.failure === original })
  }), { concurrency: 1 })
  return { originalAckErrorVerified: true, noSendBeforeAck: true, errors: evidence }
}))
const holder = (root) => Effect.scoped(Effect.gen(function* () {
  const observed = [], hookCalls = []
  const { sessions } = yield* build(root, (base) => SessionLog.of({ ...base, commit: (id, input) => base.commit(id, input).pipe(Effect.tap((committed) => input.events.some((event) => event.kind === "request.prepared")
    ? Effect.gen(function* () {
      const protocol = committed.events.filter((event) => event.kind === "request.part" || event.kind === "request.prepared")
      assert.ok(protocol.some((event) => event.kind === "request.part"))
      assert.equal(protocol.at(-1).kind, "request.prepared")
      assert.equal(protocol.filter((event) => event.kind === "request.prepared").length, 1)
      assert.equal(observed.length, 0)
      assert.equal(hookCalls.length, 1)
      yield* say(`held ${JSON.stringify({ revision: committed.revision, header: protocol.at(-1).seq, parts: protocol.length - 1, calls: observed.length, hookCalls: hookCalls.length })}`)
      yield* say("ack-held")
      yield* Effect.never
    }) : Effect.void)) }))
  yield* sessions.create(targets.held)
  return yield* runTurn(sessions, targets.held, "hook-held", { observed, hookCalls, single: true, forbidCall: true })
}))
const inspectHeld = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw } = yield* build(root)
  const state = yield* audit(raw, targets.held)
  assert.equal(state.headers.length, 1)
  const selected = state.materialized[0]
  assert.deepEqual(selected.header.hook, { system: systemText, context: hookContext(0), toolChoice: null })
  assert.equal(state.entries.filter((entry) => entry.body._tag === "StepContext").length, 1)
  assert.equal(state.entries.find((entry) => entry.body._tag === "StepContext").body.text, combinedContext(0))
  assert.equal(state.events.filter((event) => ["tool.started", "model.called", "turn.ended"].includes(event.kind)).length, 0)
  assert.ok(!state.entries.some((entry) => entry.body._tag === "Message" && entry.body.message.role === "assistant"))
  const expected = { header: clone(selected.header), prompt: selected.prompt, seq: selected.event.seq }
  yield* Effect.tryPromise(() => writeFile(join(root, "held-replay.json"), JSON.stringify(expected)))
  return { revision: state.head.revision, header: selected.event.seq, parts: state.events.filter((event) => event.kind === "request.part").length, durableBeforeAck: true, atomicPartsHeaderVerified: true, noSendBeforeAck: true }
}))
const replayHeld = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw } = yield* build(root)
  const expected = yield* Effect.tryPromise(() => readFile(join(root, "held-replay.json"), "utf8").then(JSON.parse))
  const before = yield* raw.head(targets.held.id)
  const calls = { count: 0 }
  const hook = ModelRequestHook.of({ prepare: () => { calls.count++; return Effect.die(new Error("cold replay invoked a changed hook")) } })
  const state = yield* audit(raw, targets.held).pipe(Effect.provideService(ModelRequestHook, hook))
  const selected = state.materialized.find(({ event }) => event.seq === expected.seq)
  assert.ok(selected)
  assert.deepEqual(clone(selected.header), expected.header)
  assert.deepEqual(selected.prompt, expected.prompt)
  assert.equal(calls.count, 0)
  const after = yield* raw.head(targets.held.id)
  assert.deepEqual([after.seq, after.revision], [before.seq, before.revision])
  return { coldReplayHookSkipped: true, readOnlyReopenVerified: true, header: expected.seq, hookCalls: 0 }
}))
const recover = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw, sessions } = yield* build(root)
  const before = yield* audit(raw, targets.held)
  const result = yield* runTurn(sessions, targets.held, "hook-resumed", { single: true, resume: true })
  const state = yield* audit(raw, targets.held)
  checkApplied(state, result, "tail", { single: true })
  assert.equal(result.observed.length, 1)
  assert.equal(result.hookCalls.length, 1)
  assert.equal(state.headers.length, before.headers.length + 1)
  assert.equal(state.events.filter((event) => event.kind === "request.part").length, before.events.filter((event) => event.kind === "request.part").length)
  const endings = yield* readStored("turn.ended", state.events)
  assert.equal(endings.length, 2)
  assert.ok(Option.exists(endings[0].data.failure, (failure) => failure.code === "turn.takeover"))
  yield* replayHeld(root)
  return { heldAckRestartVerified: true, takeoverFreshDecisionVerified: true, calls: 1, hookCalls: 1, headers: state.headers.length }
}))
const startChild = (action, root, children) => {
  const child = spawn(process.execPath, [self, action, root], { stdio: ["ignore", "pipe", "pipe"] })
  children.add(child)
  const output = { text: "", errors: "", waiters: [] }
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => { children.delete(child); resolve({ code, signal }) })
  })
  const append = (key, chunk) => {
    output[key] += chunk
    if (Buffer.byteLength(output[key]) > 1_048_576) { output[key] = output[key].slice(0, 65_536); child.kill("SIGKILL") }
    output.waiters.forEach((inspect) => inspect())
  }
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => append("text", chunk))
  child.stderr.on("data", (chunk) => append("errors", chunk))
  const lines = () => output.text.split("\n")
  const waitFor = (line) => Promise.race([
    new Promise((resolve) => { const inspect = () => { if (lines().includes(line)) resolve() }; output.waiters.push(inspect); inspect() }),
    completion.then((ended) => { throw new Error(`${action} ended before ${line}: ${JSON.stringify(ended)}\n${output.text}\n${output.errors}`) }),
  ])
  return { output, completion, waitFor,
    checkpoint: (prefix) => JSON.parse(lines().find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? "null"),
    done: async () => { const ended = await completion; assert.equal(ended.code, 0, `${action} failed: ${output.text}\n${output.errors}`); assert.equal(output.errors, "", `${action} wrote unexpected diagnostics`); const result = lines().find((line) => line.startsWith("result ")); assert.ok(result, `${action} produced no evidence`); return JSON.parse(result.slice(7)) },
    kill: async () => { assert.equal(child.kill("SIGKILL"), true); assert.equal((await completion).signal, "SIGKILL") },
  }
}
const journey = async () => {
  const checks = modelRequestHookConformance()
  assert.equal(checks.length, 7)
  await Effect.runPromise(Effect.forEach(checks, (check) => check.run, { concurrency: 1 }))
  const root = await mkdtemp(join(tmpdir(), "efferent-request-hook-"))
  const children = new Set()
  const deadline = { timer: undefined }
  const killAll = () => children.forEach((child) => child.kill("SIGKILL"))
  process.once("exit", killAll)
  try {
    return await Promise.race([(async () => {
      const main = join(root, "main")
      const recorded = await startChild("record", main, children).done()
      const cold = await startChild("cold-replay", main, children).done()
      const mutated = await startChild("mutation", join(root, "mutation"), children).done()
      const control = await startChild("controls", join(root, "controls"), children).done()
      const failed = await startChild("errors", join(root, "errors"), children).done()
      const heldRoot = join(root, "held")
      const began = performance.now()
      const holding = startChild("holder", heldRoot, children)
      await holding.waitFor("ack-held")
      const committed = holding.checkpoint("held ")
      const inspected = await startChild("inspect-held", heldRoot, children).done()
      assert.deepEqual([committed.revision, committed.header, committed.parts], [inspected.revision, inspected.header, inspected.parts])
      assert.equal(committed.calls, 0); assert.equal(committed.hookCalls, 1)
      assert.ok(!holding.output.text.includes("unexpected-model-send"))
      assert.equal(holding.output.errors, "")
      await holding.kill()
      const replayed = await startChild("replay-held", heldRoot, children).done()
      const recovered = await startChild("recover", heldRoot, children).done()
      assert.ok(performance.now() - began < 60_000, "takeover waited for the old lease")
      await startChild("replay-held", heldRoot, children).done()
      const flags = Object.fromEntries([recorded, cold, mutated, control, failed, inspected, replayed, recovered].flatMap(Object.entries).filter(([, value]) => typeof value === "boolean"))
      console.log(`request-hook ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", checks: checks.length, kitVerified: true, ...flags, recorded, coldReplay: cold, mutation: mutated, controls: control, failures: failed, held: inspected, replayed, recovered })}`)
    })(), new Promise((_, reject) => { deadline.timer = setTimeout(() => reject(new Error("request-hook controller deadline elapsed")), 50_000) })])
  } finally {
    clearTimeout(deadline.timer)
    await Promise.all([...children].map((child) => new Promise((resolve) => { child.once("close", resolve); child.kill("SIGKILL") })))
    process.off("exit", killAll)
    await rm(root, { recursive: true, force: true })
  }
}
const watchdog = setTimeout(() => { console.error(`request-hook fixture timed out in ${mode}`); process.exit(2) }, 65_000)
if (mode === "journey") watchdog.unref()
try {
  if (mode === "journey") await journey()
  else {
    const work = mode === "record" ? record(directory) : mode === "cold-replay" ? coldReplay(directory) : mode === "mutation" ? mutation(directory)
      : mode === "controls" ? controls(directory) : mode === "errors" ? errors(directory) : mode === "holder" ? holder(directory)
        : mode === "inspect-held" ? inspectHeld(directory) : mode === "replay-held" ? replayHeld(directory) : mode === "recover" ? recover(directory)
          : Effect.die(`unknown request-hook fixture mode ${mode}`)
    await Effect.runPromise((mode === "holder" ? work : work.pipe(Effect.timeout("20 seconds"))).pipe(Effect.flatMap(done)))
  }
} finally { clearTimeout(watchdog) }
