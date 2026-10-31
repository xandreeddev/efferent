/** Real files and child processes; synthetic responses prove storage, not live providers. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool } from "effect/ai"
import * as Core from "@xandreed/core"
import {
  canonicalJson, ConversationId, CurrentModelCallPolicy, CurrentPromptCacheKey,
  defineCapability, defineSkill, defineTool, describeModel, entriesOfEvents,
  Failure, frameworkDraft, harnessCodeOf, journalSchemaOf, ModelRequestHeader,
  readStored, replayModelRequest, RunId, RunOrdinal, SessionLog, SessionLogError,
  Sessions, STORED_FORMAT, toolCallStatesOf, TurnAdmissionOpen, TurnMemory, UserMessage,
} from "@xandreed/core"
import { toolParametersSchema } from "@xandreed/core/internal"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionLogFilesLive } from "@xandreed/plugin-session-files"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"

const self = fileURLToPath(import.meta.url)
const mode = process.argv[2]?.startsWith("--") ? "journey" : process.argv[2] ?? "journey"
const directory = process.argv[3]
const owner = "request-parts-fixture"
const parent = { id: ConversationId.make("00000000-0000-4000-8000-000000002101"), owner }
const child = { id: ConversationId.make("00000000-0000-4000-8000-000000002102"), owner }
const held = { id: ConversationId.make("00000000-0000-4000-8000-000000002103"), owner }
const usage = { inputTokens: { total: 8 }, outputTokens: { total: 3 } }
const finish = (reason) => ({ type: "finish", reason, usage })
const check = (condition, message) => Effect.sync(() => assert.ok(condition, message))
const say = (line) => Effect.sync(() => process.stdout.write(`${line}\n`))
const query = { after: 0, limit: Option.none(), kinds: [] }
const systemOf = (version) => `Preserve the request-parts checkpoint ${version}.`
const Probe = Tool.make("parts_checkpoint", {
  description: "Return the request-parts fixture checkpoint.", parameters: Tool.EmptyParams,
  success: Schema.String, failure: Failure, failureMode: "return",
})
const Extra = (version) => Tool.make("parts_schema", {
  description: "Describe the request-parts fixture checkpoint.",
  parameters: version === "A" ? Schema.Struct({ value: Schema.String }) : Schema.Struct({ value: Schema.Int }),
  success: Schema.String, failure: Failure, failureMode: "return",
})

const build = (root, decorate = (log) => log) => Effect.gen(function* () {
  const files = yield* Layer.build(SessionLogFilesLive(root))
  const raw = Context.get(files, SessionLog)
  const log = decorate(raw)
  const context = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 120_000, renew: "on-commit" } }).pipe(
    Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)),
  ))
  return { sessions: Context.get(context, Sessions), log, raw }
})

/** Explicit ancestry collector: every seq comparison belongs to its own session. */
const visible = (log, address, through = Infinity) => Effect.gen(function* () {
  const head = yield* log.head(address.id)
  const inherited = yield* Option.match(head.header.parent, {
    onNone: () => Effect.succeed([]),
    onSome: (lineage) => lineage.through === 0 ? Effect.succeed([]) : visible(log, { id: lineage.id, owner }, lineage.through),
  })
  const own = yield* log.read(address.id, query)
  return [...inherited, ...own.filter((event) => event.seq <= through)]
})
const ownParts = (events, address) => events.filter((event) => event.session === address.id && event.kind === "request.part")
const bodyReferences = (header) => [header.system, ...header.tools]
const sameId = (a, b) => a.session === b.session && a.seq === b.seq

const compose = (version, handler) => Agent.define({
  plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
  capabilities: [defineCapability({ id: "request-parts-fixture", version: "1",
    tools: [defineTool({ tool: Probe, handler, annotations: { readOnly: true } }), defineTool({ tool: Extra(version), handler: () => Effect.succeed("schema only"), annotations: { readOnly: true } })],
    skills: [defineSkill({ id: "request-parts-fixture", summary: "Use the request-parts fixture checkpoint.", always: true, tools: [Probe.name, "parts_schema"] })],
  })],
  system: systemOf(version), turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 3 },
})

const runTurn = (sessions, address, runName, version = "A", options = {}) => Effect.gen(function* () {
  const observed = options.observed ?? []
  const handlers = yield* Ref.make(0)
  const handle = Effect.gen(function* () {
    yield* Ref.update(handlers, (count) => count + 1)
    const states = yield* toolCallStatesOf(yield* sessions.read(address))
    assert.equal(states.filter((state) => state.toolCallId === `${runName}-call` && state._tag === "Started").length, 1, "handler ran before durable assistant/tool.started")
    return "The request-parts checkpoint was recorded."
  })
  const agent = options.shared?.agent ?? (yield* compose(version, () => handle))
  if (options.shared) yield* Ref.set(options.shared.handler, handle)
  const model = describeModel(yield* LanguageModel.make({
    generateText: (call) => Effect.gen(function* () {
      const captured = {
        session: address.id, runId: runName, index: observed.length,
        prompt: yield* Schema.encodeEffect(Prompt.Prompt)(call.prompt),
        tools: call.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: toolParametersSchema(tool) })),
        toolChoice: call.toolChoice,
        cacheKey: Option.getOrNull(yield* CurrentPromptCacheKey), callPolicy: Option.getOrNull(yield* CurrentModelCallPolicy),
      }
      observed.push(captured)
      if (options.forbidCall) return yield* say("unexpected-provider-dispatch").pipe(Effect.andThen(Effect.die(new Error("a request dispatched before its protocol ACK"))))
      if (options.single || captured.index > 0) return [{ type: "text", text: "Request-parts checkpoint complete." }, finish("stop")]
      return [{ type: "tool-call", id: `${runName}-call`, name: Probe.name, params: {}, providerExecuted: false }, finish("tool-calls")]
    }), streamText: () => Stream.die("the request-parts fixture does not stream"),
  }), { provider: "fixture", model: "request-parts", settings: {} })
  const result = yield* agent.turn({
    turn: { session: address, runId: RunId.make(runName), userMessage: new UserMessage({ text: `Inspect request parts: ${runName}.` }), ...(options.resume ? { resumes: 1, takeOver: true } : {}) },
    services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model)),
  }, (turn) => Effect.gen(function* () {
    yield* turn.tools.select(turn.userMessage)
    const done = yield* turn.run({ stepContext: "tail", step: (step) => Effect.succeed({ context: Option.some(`Request-parts volatile step ${step.stepIndex}.`), toolChoice: Option.none() }) })
      .pipe(Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "low", maxOutputTokens: 64 })))
    return { outcome: done.outcome, reply: Option.some(done.text) }
  }))
  assert.equal(yield* Ref.get(handlers), options.single ? 0 : 1)
  return { result, observed, handlers: yield* Ref.get(handlers) }
})

const audit = (log, address) => Effect.gen(function* () {
  const events = yield* visible(log, address)
  const headers = events.filter((event) => event.kind === "request.prepared")
  const parts = events.filter((event) => event.kind === "request.part")
  assert.ok(parts.length > 0, "the real Agent writer did not persist content-addressed request.part rows")
  assert.ok(headers.some((event) => event.data.version === 2), "the real Agent writer still persists V1-only headers")
  yield* Effect.forEach(events, (event) => Option.match(journalSchemaOf(event.kind), {
    onNone: () => Effect.die(`unrecognized request-parts journal kind ${event.kind}`),
    onSome: (schema) => Schema.decodeUnknownEffect(schema)(event.data),
  }), { concurrency: 1, discard: true })
  const materialized = yield* Effect.forEach(headers, (event) => Effect.gen(function* () {
    const prefix = events.slice(0, events.indexOf(event) + 1)
    const request = yield* replayModelRequest(prefix, RunId.make(event.data.runId), event.data.step, RunOrdinal.make(event.data.run ?? 0))
    if (event.data.version === 2) assert.ok(bodyReferences(event.data).every((hash) => prefix.some((part) => part.kind === "request.part" && part.data.hash === hash)), "header references a non-visible request part")
    return { event, request, prompt: yield* Schema.encodeEffect(Prompt.Prompt)(request.prompt) }
  }), { concurrency: 1 })
  const entries = yield* entriesOfEvents(events)
  assert.ok(entries.every((entry) => entry.body._tag !== "request.part"), "request parts entered model memory")
  const head = yield* log.head(address.id)
  if (head.seq > 0) assert.equal(head.state.sessions.format, STORED_FORMAT)
  return { events, headers, parts, materialized }
})

const compare = (state, observed) => Effect.sync(() => {
  for (const actual of observed) {
    const row = state.materialized.find(({ event }) => event.data.runId === actual.runId && event.data.step === actual.index && (event.data.run ?? 0) === 0)
    assert.ok(row, "a provider call has no materialized durable request")
    assert.deepEqual(row.prompt, actual.prompt, "replayed prompt differs from the actual model call")
    assert.deepEqual(row.request.tools.map(({ name, description, parameters }) => ({ name, description, parameters })), actual.tools, "replayed tool declarations differ from the actual call")
    assert.deepEqual(row.request.toolChoice, actual.toolChoice)
    assert.equal(Option.getOrNull(row.request.cacheKey), actual.cacheKey)
    assert.deepEqual(Option.getOrNull(row.request.callPolicy), actual.callPolicy)
    assert.deepEqual(Option.getOrNull(row.request.model), { provider: "fixture", model: "request-parts", settings: {} })
  }
})

const stable = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions, raw } = yield* build(root)
  yield* sessions.create(parent)
  yield* seedLegacy(sessions, parent)
  const first = yield* runTurn(sessions, parent, "parts-first")
  const state = yield* audit(raw, parent)
  yield* compare(state, first.observed)
  const hashes = state.parts.map((part) => part.data.hash)
  assert.equal(new Set(hashes).size, hashes.length, "stable parts were duplicated across steps")
  const v2 = state.headers.filter((event) => event.data.version === 2)
  assert.deepEqual(bodyReferences(v2[0].data), bodyReferences(v2[1].data), "unchanged system/tools did not reuse their hashes")
  yield* saveCalls(root, first.observed)
  return { calls: first.observed.length, handlers: first.handlers, parts: state.parts.length, headers: state.headers.length, dedupVerified: true, replayVerified: true, mixedV1V2: true }
}))

const loadCalls = (root) => Effect.tryPromise(() => readFile(join(root, "captured-calls.json"), "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error)))
const saveCalls = (root, calls) => loadCalls(root).pipe(Effect.flatMap((old) => Effect.tryPromise(() => writeFile(join(root, "captured-calls.json"), JSON.stringify([...old, ...calls])))))
const compareVisible = (root, state) => loadCalls(root).pipe(Effect.flatMap((calls) => {
  const runs = new Set(state.headers.map((event) => event.data.runId))
  return compare(state, calls.filter((call) => runs.has(call.runId)))
}))

/** An unused synthetic V1 request is prepared honestly, without a V1 provider claim. */
const seedLegacy = (sessions, address) => Effect.gen(function* () {
  const writer = yield* sessions.begin(address, {
    _tag: "User", runId: RunId.make("parts-legacy-unused"), key: "parts-legacy-unused", command: {}, userMessage: new UserMessage({ text: "Synthetic V1 compatibility checkpoint." }),
  })
  const agent = yield* compose("A", () => Effect.die("the synthetic V1 seed must not call tools"))
  const neverCalled = yield* LanguageModel.make({ generateText: () => Effect.die("the synthetic V1 seed must not call a model"), streamText: () => Stream.die("not scripted") })
  yield* agent.turn({ turn: writer, services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, neverCalled)) }, () => Effect.gen(function* () {
    const memory = yield* TurnMemory
    const run = yield* memory.startRun
    const built = yield* memory.session.build({ run: run.ordinal, stepContext: "none" })
    const header = {
      version: 1, runId: run.id, run: run.ordinal, step: 0, strategyVersion: memory.strategy.version,
      system: "Synthetic unused V1 compatibility request.", render: yield* memory.session.renderRecipe("none", run.ordinal),
      through: built.through, contextFingerprint: built.fingerprint,
      tools: [], toolChoice: "auto", model: Option.none(), cacheKey: Option.none(), callPolicy: Option.none(),
    }
    const data = yield* Schema.encodeEffect(ModelRequestHeader)(header)
    const { run: oldRun, ...old } = data
    const { run: oldRenderRun, ...render } = data.render
    const { maxChars: oldMaxChars, ...media } = data.render.media
    yield* writer.append([frameworkDraft("request.prepared", { ...old, render: { ...render, media } })])
    yield* writer.flush
    return { outcome: "completed", reply: Option.some("Synthetic V1 compatibility checkpoint complete.") }
  }))
  yield* writer.end({ reason: "completed", failure: Option.none() })
})

const restart = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions, raw } = yield* build(root)
  const before = yield* audit(raw, parent)
  yield* compareVisible(root, before)
  const oldSeq = (yield* raw.head(parent.id)).seq
  const noWriteRead = yield* audit(raw, parent)
  assert.equal((yield* raw.head(parent.id)).seq, oldSeq, "reopening/replaying wrote journal records")
  assert.ok(noWriteRead.headers.some((row) => row.data.version === 1) && noWriteRead.headers.some((row) => row.data.version === 2), "restart lost mixed V1/V2 history")
  const legacy = noWriteRead.materialized.find(({ event }) => event.data.version === 1)
  assert.equal(legacy.request.tools.length, 0)
  assert.ok(Option.isNone(legacy.request.model))
  const current = yield* runTurn(sessions, parent, "parts-cold-restart")
  const after = yield* audit(raw, parent)
  assert.equal(after.parts.length, before.parts.length, "a cold process rewrote stable parts")
  yield* compare(after, current.observed)
  yield* saveCalls(root, current.observed)
  return { headers: after.headers.length, parts: after.parts.length, coldRestartVerified: true, mixedV1V2: true, replayVerified: true }
}))

const forks = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions, raw } = yield* build(root)
  yield* sessions.fork(parent, { id: child.id, origin: "request-parts-fixture", inherit: true })
  const inherited = yield* audit(raw, child)
  const first = yield* runTurn(sessions, child, "parts-child-visible")
  const firstChild = yield* audit(raw, child)
  assert.equal(ownParts(firstChild.events, child).length, 0, "child failed to reuse visible parent parts")
  yield* compare(firstChild, first.observed)
  const ownHeader = firstChild.headers.find((event) => event.session === child.id)
  assert.ok(inherited.parts.some((event) => event.seq > ownHeader.seq), "fork fixture did not exercise overlapping parent/child seq ranges")
  const before = yield* audit(raw, parent)
  const handler = yield* Ref.make(Effect.die("no active request-parts handler"))
  const shared = { handler, agent: yield* compose("B", () => Ref.get(handler).pipe(Effect.flatMap((handle) => handle))) }
  const laterParent = yield* runTurn(sessions, parent, "parts-parent-after-fork", "B", { shared })
  const after = yield* audit(raw, parent)
  const parentNew = after.parts.filter((event) => !before.parts.some((part) => sameId(part, event)))
  assert.equal(parentNew.length, 2, "changing only the system and one tool schema wrote unrelated parts")
  assert.deepEqual(parentNew.map((event) => event.data.part._tag), ["System", "Tool"])
  const laterChild = yield* runTurn(sessions, child, "parts-child-after-parent", "B", { shared })
  const childAfter = yield* audit(raw, child)
  const childNew = ownParts(childAfter.events, child)
  assert.equal(childNew.length, 2, "child reused parent parts written after its cutoff or rewrote visible parts")
  assert.deepEqual(childNew.map((event) => event.data.hash), parentNew.map((event) => event.data.hash), "fork did not independently persist the same missing content")
  assert.ok(parentNew.every((event) => !childAfter.events.some((part) => sameId(event, part))), "child inherited a post-fork parent row")
  yield* compare(after, laterParent.observed)
  yield* compare(childAfter, laterChild.observed)
  const bare = yield* sessions.read(child)
  const bareReplay = yield* Effect.result(replayModelRequest(bare, RunId.make("parts-child-visible"), 0))
  assert.equal(bareReplay._tag, "Failure", "bare child rows resolved missing inherited dependencies")
  yield* saveCalls(root, [...first.observed, ...laterParent.observed, ...laterChild.observed])
  return { parentNew: parentNew.length, childNew: childNew.length, inheritedParts: inherited.parts.length, forkCutoffVerified: true, replayVerified: true }
}))

const coldFork = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions, raw } = yield* build(root)
  const before = yield* audit(raw, child)
  yield* compareVisible(root, before)
  const newRun = yield* runTurn(sessions, child, "parts-child-cold", "B")
  const after = yield* audit(raw, child)
  assert.equal(ownParts(after.events, child).length, ownParts(before.events, child).length, "cold fork wrote already visible parts")
  yield* compare(after, newRun.observed)
  yield* saveCalls(root, newRun.observed)
  return { parts: after.parts.length, ownParts: ownParts(after.events, child).length, coldForkVerified: true, replayVerified: true }
}))

const integrity = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw } = yield* build(root)
  const state = yield* audit(raw, parent)
  const selected = state.headers.find((event) => event.data.version === 2)
  const selectedIndex = state.events.indexOf(selected)
  const prefix = state.events.slice(0, selectedIndex + 1)
  const part = prefix.find((event) => event.kind === "request.part" && event.data.hash === selected.data.system)
  const at = { session: selected.session, seq: selected.seq }
  const original = yield* Core.resolveRequestHeader(prefix, at)
  const malformed = { ...part, data: { ...part.data, part: { _tag: "System", text: "Tampered selected system." } } }
  const missing = prefix.filter((event) => !sameId(event, part))
  const maxSeq = Math.max(...state.events.map((event) => event.seq))
  const later = { ...part, seq: maxSeq + 1 }
  const checks = []
  const expectCode = (name, events, target, expected = "request.diverged") => Effect.gen(function* () {
    const result = yield* Effect.result(Core.resolveRequestHeader(events, target))
    assert.equal(result._tag, "Failure", `${name}: corrupted selected request resolved`)
    assert.equal(Option.getOrNull(harnessCodeOf(result.failure)), expected, `${name}: corruption classification changed`)
    checks.push(name)
  })
  yield* expectCode("missing", missing, at)
  yield* expectCode("hash", prefix.map((event) => sameId(event, part) ? malformed : event), at)
  yield* expectCode("future-cannot-heal", [...missing, later], at)
  yield* expectCode("unsupported-version", prefix.map((event) => sameId(event, selected) ? { ...event, data: { ...event.data, version: 99 } } : event), at, "request.decode")
  const copiedHeader = { ...selected, seq: maxSeq + 2 }
  const copiedAt = { session: copiedHeader.session, seq: copiedHeader.seq }
  const equal = yield* Core.resolveRequestHeader([...state.events, later, copiedHeader], copiedAt)
  assert.equal(canonicalJson(equal), canonicalJson(original), "identical duplicate changed materialized header")
  checks.push("equal-duplicate")
  yield* expectCode("conflicting-duplicate", [...state.events, { ...malformed, seq: maxSeq + 1 }, copiedHeader], copiedAt)
  const stillEarlier = yield* Core.resolveRequestHeader([...prefix, { ...malformed, seq: maxSeq + 1 }], at)
  assert.equal(canonicalJson(stillEarlier), canonicalJson(original), "a future conflict poisoned earlier replay")
  checks.push("future-conflict-ignored")
  const unreferenced = { ...part, seq: maxSeq + 1, data: { hash: "f".repeat(64), part: { _tag: "NotARequestPart" } } }
  const unrelated = yield* Core.resolveRequestHeader([...state.events, unreferenced, copiedHeader], copiedAt)
  assert.equal(canonicalJson(unrelated), canonicalJson(original), "unreferenced malformed body poisoned selected replay")
  checks.push("unreferenced-body-ignored")
  const badOther = { ...copiedHeader, seq: maxSeq + 1, data: { ...copiedHeader.data, runId: "unrelated-invalid-header", version: 99 } }
  yield* replayModelRequest([...state.events, badOther, copiedHeader], RunId.make(selected.data.runId), selected.data.step, RunOrdinal.make(selected.data.run ?? 0))
  checks.push("unrelated-header-body-ignored")
  return { checks: checks.length, integrityVerified: true, prefixVerified: true }
}))

const tamper = (root, missing) => Effect.scoped(Effect.gen(function* () {
  const observed = []
  const { sessions, raw } = yield* build(root, (inner) => SessionLog.of({ ...inner,
    read: (id, input) => inner.read(id, input).pipe(Effect.map((events) => events.flatMap((event) => event.kind !== "request.part" ? [event]
      : missing ? [] : [{ ...event, data: { ...event.data, part: event.data.part._tag === "System" ? { _tag: "System", text: `${event.data.part.text} tampered` } : event.data.part } }]))),
  }))
  const address = missing ? { id: held.id, owner } : parent
  if (missing) yield* sessions.create(address)
  const startsBefore = (yield* visible(raw, address)).filter((event) => event.kind === "tool.started").length
  const result = yield* Effect.result(runTurn(sessions, address, missing ? "parts-missing-read" : "parts-tampered-read", missing ? "H" : "B", { observed, forbidCall: true }))
  assert.equal(result._tag, "Failure", "tampered request unexpectedly ran")
  assert.equal(Option.getOrNull(harnessCodeOf(result.failure)), "request.diverged", "durable corruption was remapped as caller encoding or provider failure")
  assert.equal(observed.length, 0, "tampered/missing selected dependency reached the provider")
  const data = yield* visible(raw, address)
  assert.equal(data.filter((event) => event.kind === "tool.started").length, startsBefore, "tampering admitted another tool")
  return { mode: missing ? "missing" : "tampered", calls: observed.length, noDispatchVerified: true }
}))

const holder = (root) => Effect.scoped(Effect.gen(function* () {
  const observed = []
  const { sessions } = yield* build(root, (inner) => SessionLog.of({ ...inner,
    commit: (id, input) => inner.commit(id, input).pipe(Effect.tap((committed) => input.events.some((event) => event.kind === "request.prepared")
      ? Effect.gen(function* () {
        assert.equal(observed.length, 0, "a provider ran before its protocol ACK")
        const protocol = committed.events.filter((event) => event.kind === "request.part" || event.kind === "request.prepared")
        assert.ok(protocol.some((event) => event.kind === "request.part"), "held ACK did not include new request parts")
        assert.equal(protocol.at(-1).kind, "request.prepared", "header was committed before its dependencies")
        assert.equal(protocol.filter((event) => event.kind === "request.prepared").length, 1)
        yield* say(`held ${JSON.stringify({ revision: committed.revision, parts: protocol.length - 1, header: protocol.at(-1).seq, calls: observed.length })}`)
        yield* say("ack-held")
        yield* Effect.never
      }) : Effect.void)),
  }))
  yield* sessions.create(held)
  return yield* runTurn(sessions, held, "parts-held", "H", { observed, forbidCall: true })
}))

const inspectHeld = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw } = yield* build(root)
  const state = yield* audit(raw, held)
  assert.equal(state.headers.length, 1)
  assert.equal(state.events.filter((event) => event.kind === "tool.started" || event.kind === "turn.ended").length, 0, "held request escaped before ACK")
  const entries = yield* entriesOfEvents(state.events)
  assert.ok(!entries.some((entry) => entry.body._tag === "Message" && entry.body.message.role === "assistant"), "held request persisted an unaccepted assistant response")
  const head = yield* raw.head(held.id)
  return { revision: head.revision, parts: state.parts.length, header: state.headers[0].seq, durableBeforeAck: true }
}))

const recoverHeld = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions, raw } = yield* build(root)
  const before = yield* audit(raw, held)
  const recovered = yield* runTurn(sessions, held, "parts-held-resume", "H", { resume: true })
  const after = yield* audit(raw, held)
  assert.equal(after.parts.length, before.parts.length, "restart after a committed ACK loss rewrote durable parts")
  assert.equal(after.headers.length, 3, "restart lost the abandoned header or duplicated a model request")
  const endings = yield* readStored("turn.ended", after.events)
  assert.equal(endings.length, 2)
  assert.ok(Option.exists(endings[0].data.failure, (failure) => failure.code === "turn.takeover"), "restart waited for a lease instead of explicit takeover")
  yield* compare(after, recovered.observed)
  yield* saveCalls(root, recovered.observed)
  return { parts: after.parts.length, headers: after.headers.length, calls: recovered.observed.length, handlers: recovered.handlers, heldAckRestartVerified: true, replayVerified: true }
}))

const report = (value) => say(`result ${JSON.stringify(value)}`)
const startChild = (action, root, children) => {
  const child = spawn(process.execPath, [self, action, root], { stdio: ["ignore", "pipe", "pipe"] })
  children.add(child)
  const output = { text: "", errors: "", waiters: [] }
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => { children.delete(child); resolve({ code, signal }) })
  })
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { output.text += chunk; output.waiters.forEach((inspect) => inspect()) })
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { output.errors += chunk })
  const lines = () => output.text.split("\n")
  const waitFor = (line) => Promise.race([
    new Promise((resolve) => { const inspect = () => { if (lines().includes(line)) resolve() }; output.waiters.push(inspect); inspect() }),
    completion.then((ended) => { throw new Error(`${action} ended before ${line}: ${JSON.stringify(ended)}\n${output.text}\n${output.errors}`) }),
  ])
  const done = async () => {
    const ended = await completion
    assert.equal(ended.code, 0, `${action} failed: ${output.text}\n${output.errors}`)
    assert.equal(output.errors, "", `${action} wrote unexpected errors`)
    return JSON.parse(lines().find((line) => line.startsWith("result "))?.slice(7) ?? "null")
  }
  return { done, waitFor, completion, output,
    checkpoint: (prefix) => JSON.parse(lines().find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? "null"),
    kill: async () => { child.kill("SIGKILL"); assert.equal((await completion).signal, "SIGKILL") },
  }
}

const journey = async () => {
  const root = await mkdtemp(join(tmpdir(), "efferent-request-parts-"))
  const children = new Set()
  const deadline = { timer: undefined }
  try {
    await Promise.race([
      (async () => {
        const storage = join(root, "main")
        const stableResult = await startChild("stable", storage, children).done()
        const selected = process.argv.find((argument) => argument.startsWith("--case="))?.slice(7)
        if (selected === "stable") {
          console.log(`request-parts ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", stable: stableResult })}`)
          return
        }
        const restarted = await startChild("restart", storage, children).done()
        const fork = await startChild("fork", storage, children).done()
        const cold = await startChild("cold-fork", storage, children).done()
        const integrityResult = await startChild("integrity", storage, children).done()
        const tampered = await startChild("tamper", storage, children).done()
        const missing = await startChild("missing", join(root, "missing"), children).done()
        const heldStorage = join(root, "held")
        const began = performance.now()
        const holder = startChild("holder", heldStorage, children)
        await holder.waitFor("ack-held")
        const committed = holder.checkpoint("held ")
        const durable = await startChild("inspect-held", heldStorage, children).done()
        assert.ok(durable.durableBeforeAck)
        assert.deepEqual({ revision: committed.revision, parts: committed.parts, header: committed.header }, { revision: durable.revision, parts: durable.parts, header: durable.header }, "the independently reopened files differ from the actual held commit")
        await holder.kill()
        assert.equal(committed.calls, 0)
        assert.ok(!holder.output.text.includes("unexpected-provider-dispatch"), "the held protocol ACK allowed a provider dispatch")
        assert.equal(holder.output.errors, "", "the held process reported an error before SIGKILL")
        const recovered = await startChild("recover-held", heldStorage, children).done()
        assert.ok(performance.now() - began < 60_000, "restart waited for a live lease instead of takeover")
        const reopened = await startChild("read-held", heldStorage, children).done()
        assert.equal(reopened.headers, recovered.headers)
        console.log(`request-parts ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", stable: stableResult, restart: restarted, fork, coldFork: cold, integrity: integrityResult, tampered, missing, held: { ...recovered, durableBeforeAck: true, atomicDependencyBatch: true }, readOnlyReopen: reopened })}`)
      })(),
      new Promise((_, reject) => { deadline.timer = setTimeout(() => reject(new Error("the request-parts controller deadline elapsed")), 45_000) }),
    ])
  } finally {
    clearTimeout(deadline.timer)
    await Promise.all([...children].map((child) => new Promise((resolve) => { child.once("close", resolve); child.kill("SIGKILL") })))
    await rm(root, { recursive: true, force: true })
  }
}

const watchdog = setTimeout(() => { console.error(`request-parts fixture timed out in ${mode}`); process.exit(2) }, 60_000)
if (mode === "journey") watchdog.unref()
try {
  if (mode === "journey") await journey()
  else {
    const work = mode === "stable" ? stable(directory) : mode === "restart" ? restart(directory) : mode === "fork" ? forks(directory)
      : mode === "cold-fork" ? coldFork(directory) : mode === "integrity" ? integrity(directory) : mode === "tamper" ? tamper(directory, false)
        : mode === "missing" ? tamper(directory, true) : mode === "holder" ? holder(directory) : mode === "inspect-held" ? inspectHeld(directory)
          : mode === "recover-held" ? recoverHeld(directory) : mode === "read-held" ? Effect.scoped(Effect.gen(function* () {
            const { raw } = yield* build(directory)
            const before = (yield* raw.head(held.id)).seq
            const state = yield* audit(raw, held)
            yield* compareVisible(directory, state)
            assert.equal((yield* raw.head(held.id)).seq, before, "read-only reopen wrote events")
            return { headers: state.headers.length, parts: state.parts.length, noWritesVerified: true, replayVerified: true }
          })) : Effect.die(`unknown request-parts action ${mode}`)
    await Effect.runPromise(work.pipe(Effect.flatMap(report), Effect.timeout("20 seconds")))
  }
} finally { clearTimeout(watchdog) }
