/** Real Agent/files interceptor evidence, shared by source Bun and packed Node/Bun. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Schema, SchemaGetter, Stream } from "effect"
import { LanguageModel, Prompt, Tool } from "effect/ai"
import { ConversationId, CurrentAgentRun, CurrentAgentStep, defineCapability, defineSkill, defineTool, describeModel, entriesOfEvents, Failure, journalSchemaOf, onTool, replayModelRequest, resolveRequestHeader, RunId, SessionLog, Sessions, STORED_FORMAT, subscribeAll, toolCallStatesOf, toolInputOf, ToolInterceptor, ToolRegistry, TurnAdmissionOpen, TurnMemory, UserMessage } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionLogFilesLive } from "@xandreed/plugin-session-files"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"

const self = fileURLToPath(import.meta.url)
const mode = process.argv[2] ?? "journey"
const directory = process.argv[3]
const target = { owner: "tool-interceptor-fixture", id: ConversationId.make("00000000-0000-4000-8000-000000002901") }
const query = { after: 0, limit: Option.none(), kinds: [] }
const toolName = "interceptor_checkpoint"
const finish = (reason = "stop") => ({ type: "finish", reason, usage: { inputTokens: { total: 4 }, outputTokens: { total: 1 } } })
const say = (text) => Effect.sync(() => process.stdout.write(`${text}\n`))
const done = (value) => say(`result ${JSON.stringify(value)}`)
const clone = (value) => JSON.parse(JSON.stringify(value))
const build = (root) => Effect.gen(function* () {
  const raw = Context.get(yield* Layer.build(SessionLogFilesLive(join(root, "sessions"))), SessionLog)
  const context = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 120_000, renew: "on-commit" } }).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, raw), TurnAdmissionOpen))))
  return { raw, sessions: Context.get(context, Sessions) }
})
const audit = (log) => Effect.gen(function* () {
  const events = yield* log.read(target.id, query)
  yield* Effect.forEach(events, (event) => Option.match(journalSchemaOf(event.kind), { onNone: () => Effect.die(`unknown journal kind ${event.kind}`), onSome: (schema) => Schema.decodeUnknownEffect(schema)(event.data) }), { concurrency: 1, discard: true })
  const entries = yield* entriesOfEvents(events)
  const states = yield* toolCallStatesOf(events)
  const head = yield* log.head(target.id)
  assert.equal(head.state.sessions.format, STORED_FORMAT)
  return { events, entries, states, head }
})
const rawResults = (state) => state.entries.filter((entry) => entry.body._tag === "ToolResult" && entry.body.toolName === toolName)
const rewritten = { lane: "fast", n: "007" }
const numberFromString = Schema.String.pipe(Schema.decodeTo(Schema.Number, { decode: SchemaGetter.transform(Number), encode: SchemaGetter.transform(String) }))
const runTurn = (root, raw, sessions, options = {}) => Effect.gen(function* () {
  const metrics = options.metrics ?? { observed: [], before: [], after: [], actual: [], viewed: [] }
  const { observed, before, after, actual, viewed } = metrics
  const heldAfter = yield* Deferred.make()
  const Output = Schema.Struct({ lane: Schema.String, value: Schema.String })
  const output = options.holdView ? Output.pipe(Schema.decodeTo(Output, {
    decode: SchemaGetter.transformEffect((value) => Effect.gen(function* () {
      const stored = yield* audit(raw)
      if (rawResults(stored).some((entry) => entry.body.encoded.lane === value.lane) && (yield* Ref.getAndSet(options.viewArmed, false))) {
        yield* say("view-held")
        yield* Deferred.succeed(options.viewEntered, undefined)
        yield* Deferred.await(options.viewRelease)
      }
      return value
    })), encode: SchemaGetter.transform((value) => value),
  })) : Output
  const Probe = Tool.make(toolName, { description: "Return the interceptor fixture checkpoint.", parameters: Schema.Struct({ lane: Schema.Literals(["fast", "held"]), n: numberFromString }), success: output, failure: Failure, failureMode: "return" })
  const typed = (phase, result, params) => {
    assert.ok(options.recover || before.length > 0, "the real Agent ignored its ToolInterceptor")
    assert.equal(typeof params.n, "number", `${phase} received encoded parameters`)
    assert.equal(params.n, params.lane === "fast" ? 7 : 2, `${phase} lost the accepted rewrite`)
    viewed.push({ phase, lane: params.lane, n: params.n })
    return `${phase.toUpperCase()} ${params.n} ${result.value}`
  }
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [defineCapability({ id: "tool-interceptor-fixture", version: "1", tools: [defineTool({ tool: Probe, annotations: { readOnly: true }, handler: (params) => Effect.gen(function* () {
      assert.equal(options.recover, undefined, "cold resume reran an old handler")
      assert.equal(typeof params.n, "number")
      yield* Effect.tryPromise(() => writeFile(join(root, `handler-${params.lane}`), JSON.stringify(params), { flag: "wx" }))
      return { lane: params.lane, value: `ACTUAL-${params.n}` }
    }), view: { version: "1", render: (result, params) => typed("view", result, params), compact: (result, params) => typed("compact", result, params), digest: { _tag: "Select", version: "1", instructions: "Keep the checkpoint.", items: (result) => [{ key: result.value, text: result.value }], render: (result, params) => typed("digest", result, params) } } })], skills: [defineSkill({ id: "tool-interceptor-fixture", summary: "Use the interceptor checkpoint.", always: true, tools: [toolName] })] })],
    turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 3, toolConcurrency: 2 },
  })
  const interceptor = ToolInterceptor.of({
    before: (input) => Effect.gen(function* () {
      assert.equal(options.recover, undefined, "cold resume replayed a before hook")
      assert.ok(Object.isFrozen(input) && Object.isFrozen(input.input), "callback evidence is not frozen")
      assert.deepEqual(input.run, yield* CurrentAgentRun, "interceptor lost its actual run context")
      assert.equal(input.step, Option.getOrThrow(yield* CurrentAgentStep), "interceptor lost its actual step context")
      before.push(clone(input))
      return input.input.lane === "fast" ? { _tag: "Rewrite", input: rewritten } : { _tag: "Allow" }
    }),
    after: (input) => Effect.gen(function* () {
      assert.equal(options.recover, undefined, "cold resume replayed an after hook")
      after.push(clone(input))
      assert.equal(input.outcome._tag, "Success")
      assert.equal(input.outcome.encoded.value, input.input.lane === "fast" ? "ACTUAL-7" : "ACTUAL-2")
      if (input.input.lane === "held" && options.holdAfter) {
        yield* Deferred.succeed(heldAfter, undefined)
        yield* say("after-held")
        if (options.afterEntered) yield* Deferred.succeed(options.afterEntered, undefined)
        return yield* Effect.never
      }
      // The fast result's existing audit/raw flush then also acknowledges the
      // sibling's actual completion; after-entered alone is not durable proof.
      if (options.holdAfter) yield* Deferred.await(heldAfter)
      return { _tag: "Replace", outcome: { _tag: "Success", encoded: { lane: input.input.lane, value: `EFFECTIVE-${input.input.lane === "fast" ? 7 : 2}` } } }
    }),
  })
  const model = describeModel(yield* LanguageModel.make({ generateText: (call) => Effect.gen(function* () {
    observed.push(yield* Schema.encodeEffect(Prompt.Prompt)(call.prompt))
    if (options.recover || observed.length > 1) return [{ type: "text", text: "Interceptor checkpoint complete." }, finish()]
    return [...(options.holdAfter ? ["fast", "held"] : ["fast"]).map((lane) => ({ type: "tool-call", id: `intercept-${lane}`, name: toolName, params: { lane, n: lane === "fast" ? "001" : "002" }, providerExecuted: false })), finish("tool-calls")]
  }), streamText: () => Stream.die("not scripted") }), { provider: "fixture", model: "tool-interceptor", settings: {} })
  const services = Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model), Context.add(ToolInterceptor, interceptor))
  const result = yield* agent.turn({ turn: { session: target, runId: RunId.make(options.recover ? "interceptor-resume" : "interceptor-run"), key: options.recover ? "interceptor-resume" : "interceptor-run", userMessage: new UserMessage({ text: options.recover ? "Continue." : "Inspect both checkpoints." }), ...(options.resume ? { resumes: 1, takeOver: true } : {}) }, services }, (turn) => Effect.gen(function* () {
    yield* subscribeAll(turn.events, [onTool(Probe, (event) => Effect.sync(() => actual.push({ result: event.result, input: event.input })))])
    yield* turn.tools.select(turn.userMessage)
    if (options.inspectViews) {
      const memory = yield* TurnMemory
      const tools = yield* (yield* ToolRegistry).open(memory.session)
      const entries = yield* memory.entries
      const entry = rawResults({ entries }).find((value) => value.body.toolCallId === "intercept-fast")
      assert.ok(entry)
      const params = toolInputOf(entries, entry)
      assert.deepEqual(params, rewritten)
      const view = yield* tools.views.view(toolName, entry.body.encoded, params, false)
      const compact = yield* tools.views.compact(toolName, entry.body.encoded, params)
      const digest = yield* tools.views.digest(toolName, entry.body.encoded, params, turn.userMessage)
      assert.equal(view.text, "VIEW 7 EFFECTIVE-7")
      assert.equal(Option.getOrThrow(compact), "COMPACT 7 EFFECTIVE-7")
      assert.equal(Option.getOrThrow(Option.getOrThrow(digest).apply({ keep: ["EFFECTIVE-7"], summary: Option.none() })), "DIGEST 7 EFFECTIVE-7")
    }
    const response = yield* turn.run({})
    return { outcome: response.outcome, reply: Option.some(response.text) }
  }))
  return { result, observed, before, after, actual, viewed }
})
const record = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw, sessions } = yield* build(root)
  yield* sessions.create(target)
  const result = yield* runTurn(root, raw, sessions)
  assert.equal(result.before.length, 1, "the real Agent ignored its ToolInterceptor")
  assert.equal(result.after.length, 1)
  const state = yield* audit(raw)
  const results = rawResults(state)
  assert.equal(results.length, 1)
  assert.deepEqual(results[0].body.encoded, { lane: "fast", value: "EFFECTIVE-7" })
  assert.deepEqual(results[0].body.interception.effectiveInput, rewritten)
  assert.equal(results[0].body.interception.invocationId, result.before[0].invocationId)
  assert.equal(result.after[0].invocationId, result.before[0].invocationId)
  assert.deepEqual(result.actual, [{ result: { lane: "fast", value: "ACTUAL-7" }, input: { lane: "fast", n: 7 } }])
  assert.deepEqual(result.before[0].input, { lane: "fast", n: "001" })
  assert.deepEqual(result.after[0].input, rewritten)
  const audits = state.events.filter((event) => event.kind === "tool.intercepted")
  assert.equal(audits.length, 2)
  assert.ok(audits.every((event) => event.data.invocationId === result.before[0].invocationId))
  assertOriginal(state)
  yield* Effect.tryPromise(() => writeFile(join(root, "recorded.json"), JSON.stringify({ observed: result.observed, raw: results[0].body })))
  return { oneEffectiveAck: true, actualOnToolPreserved: true, rewriteRecorded: true, encodedEvidenceVerified: true, calls: result.observed.length, handlers: 1, results: 1 }
}))

const assertOriginal = (state) => {
  const calls = state.entries.flatMap((entry) => entry.body._tag === "Message" && entry.body.message.role === "assistant" && Array.isArray(entry.body.message.content) ? entry.body.message.content.filter((part) => part.type === "tool-call" && part.toolName === toolName) : [])
  assert.ok(calls.some((part) => part.toolCallId === "intercept-fast" && part.input.n === "001"), "raw assistant input was changed by Rewrite")
  assert.equal(calls.filter((part) => part.toolCallId === "intercept-fast").length, 1)
}
const replayAll = (state) => Effect.forEach(state.events.filter((event) => event.kind === "request.prepared"), (event) => Effect.gen(function* () {
  const prefix = state.events.slice(0, state.events.indexOf(event) + 1)
  const header = yield* resolveRequestHeader(prefix, { session: event.session, seq: event.seq })
  const request = yield* replayModelRequest(prefix, header.runId, header.step, header.run)
  return yield* Schema.encodeEffect(Prompt.Prompt)(request.prompt)
}), { concurrency: 1 })
const cold = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw } = yield* build(root)
  const before = yield* audit(raw)
  const saved = yield* Effect.tryPromise(() => readFile(join(root, "recorded.json"), "utf8").then(JSON.parse))
  const calls = { count: 0 }
  const refuse = () => { calls.count++; return Effect.die(new Error("cold replay invoked today's interceptor")) }
  assert.deepEqual(yield* replayAll(before).pipe(Effect.provideService(ToolInterceptor, ToolInterceptor.of({ before: refuse, after: refuse }))), saved.observed, "cold reconstructed requests changed")
  assert.equal(calls.count, 0)
  assert.deepEqual(rawResults(before)[0].body, saved.raw)
  assertOriginal(before)
  const after = yield* raw.head(target.id)
  assert.deepEqual([after.seq, after.revision], [before.head.seq, before.head.revision], "read-only replay wrote storage")
  return { coldReplayVerified: true, readOnlyReopenVerified: true, journalCodecVerified: true, headers: saved.observed.length }
}))
const coldViews = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw, sessions } = yield* build(root)
  const result = yield* runTurn(root, raw, sessions, { recover: true, inspectViews: true })
  assert.equal(result.before.length + result.after.length + result.actual.length, 0)
  assert.ok(["view", "compact", "digest"].every((phase) => result.viewed.some((value) => value.phase === phase && value.n === 7)))
  const state = yield* audit(raw)
  assert.equal(rawResults(state).length, 1)
  assertOriginal(state)
  return { coldViewsVerified: true, noAutomaticReplay: true, handlers: 0, hooks: 0 }
}))
const heldState = (state) => state.states.some((entry) => entry.toolCallId === "intercept-fast" && entry._tag === "Completed" && entry.result.encoded.value === "EFFECTIVE-7")
  && state.states.some((entry) => entry.toolCallId === "intercept-held" && entry._tag === "Returned")
const waitHeld = (raw) => Effect.suspend(() => audit(raw).pipe(Effect.flatMap((state) => heldState(state) ? Effect.succeed(state) : Effect.sleep("10 millis").pipe(Effect.andThen(waitHeld(raw))))))
const checkHeld = (state) => {
  assert.ok(heldState(state), "independent journal did not witness effective fast ACK and actual held completion")
  assert.equal(state.events.filter((event) => event.kind === "tool.completed").length, 2)
  assert.equal(state.events.filter((event) => event.kind === "tool.started").length, 2)
  assert.equal(rawResults(state).length, 1, "held after callback acquired a made-up durable result")
  const fast = state.states.find((entry) => entry.toolCallId === "intercept-fast")
  assert.equal(rawResults(state)[0].body.interception.invocationId, Option.getOrThrow(fast.started).invocationId)
  assert.deepEqual(rawResults(state)[0].body.interception.effectiveInput, rewritten)
  assertOriginal(state)
}
const inspector = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw } = yield* build(root)
  const state = yield* waitHeld(raw)
  checkHeld(state)
  yield* replayAll(state)
  assert.deepEqual(yield* Effect.tryPromise(() => readFile(join(root, "handler-fast"), "utf8").then(JSON.parse)), { lane: "fast", n: 7 })
  assert.deepEqual(yield* Effect.tryPromise(() => readFile(join(root, "handler-held"), "utf8").then(JSON.parse)), { lane: "held", n: 2 })
  return { incrementalSiblingAck: true, noHeldRawResult: true, journalCodecVerified: true, seq: state.head.seq, completed: 2, results: 1 }
}))
const holder = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw, sessions } = yield* build(root)
  yield* sessions.create(target)
  return yield* runTurn(root, raw, sessions, { holdAfter: true })
}))
const cancel = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw, sessions } = yield* build(root)
  yield* sessions.create(target)
  const entered = yield* Deferred.make()
  const metrics = { observed: [], before: [], after: [], actual: [], viewed: [] }
  const running = yield* Effect.forkChild(runTurn(root, raw, sessions, { holdAfter: true, afterEntered: entered, metrics }))
  yield* Deferred.await(entered)
  const independent = Context.get(yield* Layer.build(SessionLogFilesLive(join(root, "sessions"))), SessionLog)
  checkHeld(yield* waitHeld(independent))
  const cancelled = yield* sessions.cancel(target, 1)
  assert.equal(cancelled.cancelled, true)
  const exit = yield* Fiber.await(running)
  assert.equal(exit._tag, "Failure", "cancelled after callback completed normally")
  assert.ok(exit.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error?._tag === "TurnClosed" && reason.error.reason === "cancelled"), "cancellation lost the original TurnClosed")
  const state = yield* audit(independent)
  checkHeld(state)
  assert.equal(metrics.observed.length, 1, "cancel retried a model request")
  assert.equal(metrics.after.length, 2)
  assert.equal(metrics.actual.length, 2)
  assert.deepEqual(metrics.actual.map((entry) => entry.result.value).sort(), ["ACTUAL-2", "ACTUAL-7"])
  assert.equal(state.events.filter((event) => event.kind === "turn.ended").length, 1)
  assert.equal(state.events.find((event) => event.kind === "turn.ended").data.reason, "cancelled")
  return { returnedBeforeCancel: true, cancelledAfterInterruptible: true, actualOnToolPreserved: true, noHeldRawResult: true, cancelled: clone(cancelled), hooks: 4, handlers: 2, results: 1 }
}))
const heldView = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw, sessions } = yield* build(root)
  yield* sessions.create(target)
  const viewEntered = yield* Deferred.make(), viewRelease = yield* Deferred.make(), viewArmed = yield* Ref.make(true)
  const running = yield* Effect.forkChild(runTurn(root, raw, sessions, { holdView: true, viewEntered, viewRelease, viewArmed }))
  return yield* Effect.gen(function* () {
    yield* Deferred.await(viewEntered)
    const independent = Context.get(yield* Layer.build(SessionLogFilesLive(join(root, "sessions"))), SessionLog)
    const held = yield* audit(independent)
    const results = rawResults(held)
    assert.equal(results.length, 1)
    assert.equal(results[0].body.encoded.value, "EFFECTIVE-7")
    assert.deepEqual(results[0].body.interception.effectiveInput, rewritten)
    assert.equal(results[0].body.viewVersion, "raw")
    assert.equal(held.events.filter((event) => event.kind === "memory.tool-presentation").length, 0)
    assert.ok(held.states.some((entry) => entry._tag === "Completed" && entry.toolCallId === "intercept-fast"))
    yield* Deferred.succeed(viewRelease, undefined)
    const result = yield* Fiber.join(running)
    const state = yield* audit(raw)
    assert.equal(rawResults(state).length, 1)
    assert.equal(rawResults(state)[0].id, results[0].id)
    const presentations = state.events.filter((event) => event.kind === "memory.tool-presentation")
    assert.equal(presentations.length, 1)
    assert.equal(JSON.stringify(presentations).includes('"encoded"'), false, "presentation duplicated the encoded answer")
    assert.deepEqual(yield* replayAll(state), result.observed)
    return { rawBeforeView: true, oneEffectiveAck: true, presentationNoDuplicate: true, headers: result.observed.length, results: 1 }
  }).pipe(Effect.ensuring(Deferred.succeed(viewRelease, undefined)))
}))
const recover = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw, sessions } = yield* build(root)
  checkHeld(yield* audit(raw))
  const result = yield* runTurn(root, raw, sessions, { recover: true, resume: true })
  assert.equal(result.observed.length, 1)
  const prompt = JSON.stringify(result.observed[0])
  assert.equal(prompt.split("ToolInterrupted").length - 1, 1)
  assert.equal(prompt.split("EFFECTIVE-7").length - 1, 1)
  assert.equal(prompt.includes("ACTUAL-"), false)
  assert.equal(result.before.length + result.after.length + result.actual.length, 0)
  const state = yield* audit(raw)
  checkHeld(state)
  const prompts = yield* replayAll(state)
  assert.deepEqual(prompts.at(-1), result.observed[0])
  return { interruptedRepairVerified: true, noAutomaticReplay: true, coldReplayVerified: true, calls: 1, handlers: 0, hooks: 0, results: rawResults(state).length }
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
  return { output, completion,
    waitFor: (line) => Promise.race([new Promise((resolve) => { const inspect = () => { if (lines().includes(line)) resolve() }; output.waiters.push(inspect); inspect() }), completion.then((ended) => { throw new Error(`${action} ended before ${line}: ${JSON.stringify(ended)}\n${output.text}\n${output.errors}`) })]),
    done: async () => { const ended = await completion; assert.equal(ended.code, 0, `${action} failed: ${output.text}\n${output.errors}`); assert.equal(output.errors, "", `${action} wrote unexpected diagnostics`); const result = lines().find((line) => line.startsWith("result ")); assert.ok(result, `${action} produced no evidence`); return JSON.parse(result.slice(7)) },
    kill: async () => { assert.equal(child.kill("SIGKILL"), true); assert.equal((await completion).signal, "SIGKILL") },
  }
}
const journey = async () => {
  const root = await mkdtemp(join(tmpdir(), "efferent-tool-interceptor-"))
  const children = new Set()
  const deadline = { timer: undefined }
  const killAll = () => children.forEach((child) => child.kill("SIGKILL"))
  process.once("exit", killAll)
  try {
    return await Promise.race([(async () => {
      const main = join(root, "main")
      const recorded = await startChild("record", main, children).done()
      const reopened = await startChild("cold", main, children).done()
      const views = await startChild("cold-views", main, children).done()
      const presented = await startChild("view", join(root, "view"), children).done()
      const cancelRoot = join(root, "cancel")
      const cancelled = await startChild("cancel", cancelRoot, children).done()
      const resumedCancel = await startChild("recover", cancelRoot, children).done()
      const killRoot = join(root, "kill")
      const began = performance.now()
      const holding = startChild("holder", killRoot, children)
      await holding.waitFor("after-held")
      const witnessed = await startChild("inspect", killRoot, children).done()
      assert.equal(holding.output.errors, "")
      await holding.kill()
      const resumedKill = await startChild("recover", killRoot, children).done()
      assert.ok(performance.now() - began < 60_000, "recovery waited for the old lease")
      await startChild("inspect", killRoot, children).done()
      const flags = Object.fromEntries([recorded, reopened, views, presented, cancelled, resumedCancel, witnessed, resumedKill].flatMap(Object.entries).filter(([, value]) => typeof value === "boolean"))
      console.log(`tool-interceptor ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", ...flags, sigkillRecoveryVerified: true, recorded, reopened, views, presented, cancelled, resumedCancel, witnessed, resumedKill })}`)
    })(), new Promise((_, reject) => { deadline.timer = setTimeout(() => reject(new Error("tool-interceptor controller deadline elapsed")), 50_000) })])
  } finally {
    clearTimeout(deadline.timer)
    await Promise.all([...children].map((child) => new Promise((resolve) => { child.once("close", resolve); child.kill("SIGKILL") })))
    process.off("exit", killAll)
    await rm(root, { recursive: true, force: true })
  }
}

const watchdog = setTimeout(() => { console.error(`tool-interceptor fixture timed out in ${mode}`); process.exit(2) }, 65_000)
try {
  if (mode === "journey") await journey()
  else {
    const work = mode === "record" ? record(directory) : mode === "cold" ? cold(directory) : mode === "cold-views" ? coldViews(directory) : mode === "view" ? heldView(directory) : mode === "holder" ? holder(directory) : mode === "inspect" ? inspector(directory) : mode === "cancel" ? cancel(directory) : mode === "recover" ? recover(directory) : Effect.die(`unknown interceptor fixture mode ${mode}`)
    await Effect.runPromise((mode === "holder" ? work : work.pipe(Effect.timeout("20 seconds"))).pipe(Effect.flatMap(done)))
  }
} finally { clearTimeout(watchdog) }
