/** Durable render checkpoints over real files/processes; models are scripted. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool } from "effect/ai"
import {
  ConversationId, CurrentAgentRun, CurrentAgentStep, defineCapability, defineSkill,
  defineTool, describeModel, ENGINE_KEY, entriesOfEvents, Failure, frameworkDraft,
  mediaFromBase64, mediaFromBytes, mediaHashOf, MediaStore, MemorySnapshotData, ModelCallId,
  openLogSession, parseModelSelection, readStored, recordCompletion, replayModelRequest,
  RunId, RunOrdinal, SessionLog, Sessions, STORED_FORMAT, TurnAdmissionOpen, TurnMemory,
  UserMessage, UtilityCompletion, UtilityLlm, withMediaStore,
} from "@xandreed/core"
import { toolParametersSchema } from "@xandreed/core/internal"
import { memorySnapshotConformance } from "@xandreed/core/conformance"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"
import { MediaStoreDirectoryLive, SessionLogFilesLive } from "@xandreed/plugin-session-files"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"
const self = fileURLToPath(import.meta.url)
const mode = process.argv[2] ?? "journey"
const directory = process.argv[3]
const owner = "snapshot-fixture"
const parent = { id: ConversationId.make("00000000-0000-4000-8000-000000002301"), owner }
const child = { id: ConversationId.make("00000000-0000-4000-8000-000000002302"), owner }
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const bytesA = new Uint8Array(Buffer.from(png, "base64"))
const bytesB = Uint8Array.from(bytesA, (value, index) => index === bytesA.length - 1 ? value ^ 1 : value)
const imageA = await Effect.runPromise(mediaFromBase64(png, { name: "pinned.png", alt: "Pinned checkpoint." }))
const imageB = await Effect.runPromise(mediaFromBytes(bytesB, { name: "future.png", alt: "Future checkpoint." }))
const query = { after: 0, limit: Option.none(), kinds: [] }
const say = (text) => Effect.sync(() => process.stdout.write(`${text}\n`))
const selection = Option.getOrThrow(parseModelSelection("scripted:snapshot"))
const usageOf = (input, output = 1) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
const Pinned = Tool.make("snapshot_pinned", { description: "Return a pinned image checkpoint.", parameters: Tool.EmptyParams, success: Schema.Json, failure: Failure, failureMode: "return" })
const Plain = Tool.make("snapshot_plain", { description: "Return a plain checkpoint.", parameters: Tool.EmptyParams, success: Schema.String, failure: Failure, failureMode: "return" })
const build = (root, options = {}) => Effect.gen(function* () {
  const raw = Context.get(yield* Layer.build(SessionLogFilesLive(join(root, "sessions"))), SessionLog)
  const media = Context.get(yield* Layer.build(MediaStoreDirectoryLive(join(root, "media"))), MediaStore)
  const log = yield* withMediaStore(options.decorate ? options.decorate(raw) : raw).pipe(Effect.provideService(MediaStore, media))
  const services = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 120_000, renew: "on-commit" } }).pipe(
    Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)),
  ))
  return { raw, media, log, sessions: Context.get(services, Sessions) }
})
const visible = (log, address, through) => Effect.gen(function* () {
  const head = yield* log.head(address.id)
  const inherited = yield* Option.match(head.header.parent, { onNone: () => Effect.succeed([]), onSome: (lineage) => visible(log, { id: lineage.id, owner }, lineage.through) })
  return [...inherited, ...yield* log.read(address.id, { ...query, ...(through === undefined ? {} : { through }) })]
})
const capture = (root, call) => Effect.tryPromise(async () => {
  const path = join(root, "calls.json")
  const calls = await readFile(path, "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error))
  await writeFile(path, JSON.stringify([...calls, call]))
})
const complete = (callId, purpose, input, output = 1) => Effect.gen(function* () {
  const run = yield* CurrentAgentRun
  yield* recordCompletion({ callId: ModelCallId.make(callId), attempt: 1, purpose, method: "Text", model: Option.some(selection),
    runId: Option.map(run, (value) => value.id), run: Option.map(run, (value) => value.ordinal),
    step: Option.isSome(run) ? yield* CurrentAgentStep : Option.none(), durationMs: 0,
    usage: { _tag: "Known", usage: usageOf(input, output) }, outcome: { _tag: "Completed" } })
}).pipe(Effect.catch((failure) => Effect.die(failure)))

/** Observe actual CPU reuse without adding a production observer or changing data. */
const probeProjection = (session, runName, late) => Effect.gen(function* () {
  const all = yield* session.entries
  const omitted = all.find((entry) => entry.body._tag === "Message" && entry.body.message.role === "assistant"
    && entry.body.message.content.some((part) => part.type === "text" && part.text.startsWith("older-snapshot-evidence ")))
  assert.ok(omitted, "fixture lacks an omitted heavy old assistant entry")
  const descriptor = Object.getOwnPropertyDescriptor(omitted.body, "message")
  assert.ok(descriptor?.configurable, "the probe needs a configurable data property")
  const original = omitted.body.message
  const touches = { count: 0 }
  const install = () => Object.defineProperty(omitted.body, "message", { configurable: true, enumerable: true, get: () => { touches.count++; return original } })
  const restore = () => Object.defineProperty(omitted.body, "message", descriptor)
  const request = { stepContext: "none", run: RunOrdinal.make(0) }
  const recipe = yield* session.renderRecipe("none", request.run)
  const fullSession = (entries) => openLogSession({ read: Effect.succeed(entries), append: () => Effect.die("the baseline render must not write") }, {
    strategy: session.strategy, render: { turnContext: recipe.turnContext, replies: recipe.replies, digests: recipe.digests, media: recipe.media },
    digestOnWrite: Option.none(), maintain: () => Effect.succeed({ actions: [], digest: [] }),
  }, { runId: RunId.make(runName) })
  install()
  const built = yield* session.build(request)
  const projectedReads = touches.count
  touches.count = 0
  const baseline = yield* (yield* fullSession(all)).build(request)
  const fullReads = touches.count
  restore()
  assert.equal(projectedReads, 0, "cold checkpoint did not accelerate the real MemorySession.build")
  assert.ok(fullReads > 0, "the heavy-entry probe cannot distinguish full rendering")
  assert.deepEqual(built, baseline, "projected build metadata differs from the full archive")
  const plain = all.find((entry) => entry.body._tag === "ToolResult" && entry.body.toolName === Plain.name && entry.runId === "snapshot-first")
  assert.ok(plain && Option.isSome(yield* session.resolve(plain.id)), "archive recall lost the omitted plain result")
  assert.ok(JSON.stringify(yield* session.transcript("raw")).includes("older-snapshot-evidence"), "raw transcript became a projection")
  if (late) {
    yield* session.record([{ _tag: "ToolPresentation", entry: plain.id, view: "Restored old plain checkpoint.", viewVersion: "late-1", subjects: [], artifacts: [], pinned: true, media: [], mediaNotes: [] }], 0)
    touches.count = 0
    install()
    const restored = yield* session.build(request)
    const fallbackReads = touches.count
    restore()
    assert.ok(fallbackReads > 0, "late old pin did not select the full archive fallback")
    const expected = yield* (yield* fullSession(yield* session.entries)).build(request)
    assert.deepEqual(restored, expected)
    assert.ok(JSON.stringify(restored.messages).includes("Restored old plain checkpoint."))
  }
  return { projectionReuseVerified: true, archiveRecallVerified: true, fullBuildReads: fullReads, projectedBuildReads: projectedReads, ...(late ? { lateOverlayFallbackVerified: true } : {}) }
})
const runTurn = (root, sessions, address, name, options = {}) => Effect.gen(function* () {
  const image = options.image ?? imageA
  const observed = []
  const handlers = yield* Ref.make([])
  const helperPrompts = []
  const helper = UtilityLlm.of({ complete: (prompt) => Effect.gen(function* () {
    helperPrompts.push(prompt)
    yield* complete(`${name}-helper-${helperPrompts.length}`, "Helper", 7, 3)
    return new UtilityCompletion({ text: "Earlier snapshot checkpoint retained.", usage: usageOf(7, 3), model: selection })
  }) })
  const model = describeModel(yield* LanguageModel.make({ generateText: (call) => Effect.gen(function* () {
    const index = observed.length
    const captured = { runId: name, index, prompt: yield* Schema.encodeEffect(Prompt.Prompt)(call.prompt), tools: call.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: toolParametersSchema(tool) })) }
    observed.push(captured)
    yield* capture(root, captured)
    const final = options.noTools || index > 0
    const input = final ? options.input ?? 400 : 300
    yield* complete(`${name}-call-${index}`, "Loop", input)
    const finish = { type: "finish", reason: final ? "stop" : "tool-calls", usage: { inputTokens: { total: input }, outputTokens: { total: 1 } }, metadata: { [ENGINE_KEY]: { model: "scripted:snapshot" } } }
    return final ? [{ type: "text", text: options.verbose ? "older-snapshot-evidence ".repeat(180) : "Snapshot checkpoint complete." }, finish] : [
      { type: "tool-call", id: `${name}-pin`, name: Pinned.name, params: {}, providerExecuted: false },
      { type: "tool-call", id: `${name}-plain`, name: Plain.name, params: {}, providerExecuted: false }, finish,
    ]
  }), streamText: () => Stream.die("the snapshot fixture does not stream") }), { provider: "scripted", model: "snapshot", settings: {} })
  const agent = yield* Agent.define({
    plugins: [{ plugin: memorySummaryPlugin, options: { cooldownTurns: 3, media: "none", maxMediaChars: 0 } }, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [defineCapability({ id: "snapshot-fixture", version: "1", tools: [
      defineTool({ tool: Pinned, annotations: { readOnly: true, pinned: true }, view: { version: "1", render: () => "Pinned image checkpoint." }, handler: () => Ref.update(handlers, (all) => [...all, "pinned"]).pipe(Effect.as({ nested: [image] })) }),
      defineTool({ tool: Plain, annotations: { readOnly: true }, handler: () => Ref.update(handlers, (all) => [...all, "plain"]).pipe(Effect.as("Plain old checkpoint.")) }),
    ], skills: [defineSkill({ id: "snapshot-fixture", summary: "Use checkpoint tools.", always: true, tools: [Pinned.name, Plain.name] })] })],
    turnServices: [LanguageModel.LanguageModel, UtilityLlm], budgetTokens: 1_000, limits: { streaming: false, maxSteps: 3 },
  })
  const probes = {}
  const result = yield* agent.turn({ turn: { session: address, runId: RunId.make(name), userMessage: new UserMessage({ text: `Inspect checkpoint ${name}.`, attachments: [image] }), ...(options.resume ? { resumes: 2, takeOver: true } : {}) },
    services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model), Context.add(UtilityLlm, helper)),
  }, (turn) => Effect.gen(function* () {
    if (options.probe) Object.assign(probes, yield* probeProjection((yield* TurnMemory).session, name, options.late))
    yield* turn.tools.select(turn.userMessage)
    const done = yield* turn.run({})
    return { outcome: done.outcome, reply: Option.some(done.text) }
  }))
  assert.equal(observed.length, options.noTools ? 1 : 2)
  assert.equal((yield* Ref.get(handlers)).length, options.noTools ? 0 : 2)
  return { result, calls: observed.length, handlers: (yield* Ref.get(handlers)).length, helpers: helperPrompts.length, ...probes }
})
const audit = (root, log, address) => Effect.gen(function* () {
  const events = yield* visible(log, address)
  const snapshots = yield* readStored("memory.snapshot", events)
  const entries = yield* entriesOfEvents(events)
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length, "snapshot allocated/duplicated memory IDs")
  const calls = yield* Effect.tryPromise(() => readFile(join(root, "calls.json"), "utf8").then(JSON.parse))
  const headers = yield* readStored("request.prepared", events)
  yield* Effect.forEach(headers, ({ event, data }) => Effect.gen(function* () {
    const request = yield* replayModelRequest(events.slice(0, events.indexOf(event) + 1), data.runId, data.step, data.run)
    const actual = calls.find((call) => call.runId === data.runId && call.index === data.step)
    assert.ok(actual, "a durable request lost its captured model call")
    assert.deepEqual(yield* Schema.encodeEffect(Prompt.Prompt)(request.prompt), actual.prompt)
    assert.deepEqual(request.tools.map(({ name, description, parameters }) => ({ name, description, parameters })), actual.tools)
  }), { concurrency: 1 })
  const head = yield* log.head(address.id)
  if (snapshots.some(({ event }) => event.session === address.id)) {
    const latest = snapshots.filter(({ event }) => event.session === address.id).at(-1)
    assert.deepEqual(head.state.sessions.memorySnapshot, { session: address.id, seq: latest.event.seq })
  }
  assert.equal(head.state.sessions.format, STORED_FORMAT)
  return { events, snapshots, entries, headers, head }
})
const seed = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions, log } = yield* build(root)
  yield* sessions.create(parent)
  const first = yield* runTurn(root, sessions, parent, "snapshot-first", { verbose: true, input: 400 })
  assert.equal(first.helpers, 0)
  assert.equal((yield* readStored("memory.snapshot", yield* log.read(parent.id, query))).length, 0)
  return { calls: first.calls, handlers: first.handlers, seedVerified: true }
}))
const summarize = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions, log, raw } = yield* build(root)
  const done = yield* runTurn(root, sessions, parent, "snapshot-second", { noTools: true, input: 2_000 })
  assert.equal(done.helpers, 1)
  const state = yield* audit(root, log, parent)
  assert.equal(state.snapshots.length, 1, "a reducing summary did not publish exactly one checkpoint")
  const snapshot = state.snapshots[0]
  const anchor = state.events.find((event) => event.session === snapshot.data.anchor.session && event.seq === snapshot.data.anchor.seq)
  assert.equal(anchor.kind, "turn.started")
  assert.equal(anchor.data.runId, "snapshot-second")
  const plain = state.entries.find((entry) => entry.body._tag === "ToolResult" && entry.body.toolName === Plain.name)
  assert.ok(snapshot.data.entries.some((entry) => entry.body._tag === "ToolResult" && entry.body.toolName === Pinned.name))
  assert.ok(!snapshot.data.entries.some((entry) => entry.id === plain.id))
  const physical = yield* raw.read(parent.id, { after: snapshot.event.seq - 1, through: snapshot.event.seq, limit: Option.some(1), kinds: ["memory.snapshot"] })
  assert.ok(Object.hasOwn(physical[0].data, "$efferent.media"), "snapshot copied Media was not physically offloaded")
  assert.ok(!JSON.stringify(physical[0].data).includes(png))
  return { snapshots: 1, retained: snapshot.data.entries.length, archive: state.entries.length, snapshotPublishedVerified: true, pointerAtomicVerified: true, mediaSnapshotVerified: true, replayVerified: true }
}))
const reopen = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions, log } = yield* build(root)
  const before = yield* audit(root, log, parent)
  const headSeq = before.head.seq
  yield* audit(root, log, parent)
  assert.equal((yield* log.head(parent.id)).seq, headSeq)
  const current = yield* runTurn(root, sessions, parent, "snapshot-cold", { noTools: true, input: 400, probe: true, late: true })
  assert.equal(current.helpers, 0)
  yield* audit(root, log, parent)
  return { ...current, coldProjectionVerified: true, readOnlyReopenVerified: true, replayVerified: true }
}))
const forks = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions, log, media } = yield* build(root)
  yield* sessions.fork(parent, { id: child.id, origin: "snapshot-fixture", inherit: true })
  const lineage = (yield* log.head(child.id)).header.parent.value
  const old = (yield* readStored("memory.snapshot", yield* log.read(parent.id, query))).at(-1)
  const writer = yield* sessions.begin(parent, { _tag: "User", runId: RunId.make("snapshot-future-publication"), key: "snapshot-future-publication", userMessage: new UserMessage({ text: "Synthetic delayed snapshot publication.", attachments: [imageB] }), command: {} })
  yield* writer.append([frameworkDraft("memory.snapshot", yield* Schema.encodeEffect(MemorySnapshotData)(old.data))])
  yield* writer.flush
  yield* writer.end({ reason: "completed", failure: Option.none() })
  const pointer = (yield* log.head(parent.id)).state.sessions.memorySnapshot
  assert.ok(old.data.anchor.seq <= lineage.through && pointer.seq > lineage.through, "fixture lacks a future publication with an old anchor")
  yield* Effect.tryPromise(() => unlink(join(root, "media", "blobs", `${mediaHashOf(bytesB)}.bin`)))
  const forbidden = []
  const cold = yield* build(root, { decorate: (inner) => SessionLog.of({ ...inner, read: (id, input) => {
    if (id === parent.id && (input.kinds.length === 0 || input.kinds.includes("memory.snapshot")) && (input.through === undefined || input.through > lineage.through)) {
      forbidden.push(input)
      return Effect.die("child attempted to hydrate an invisible future snapshot")
    }
    return inner.read(id, input)
  } }) })
  const current = yield* runTurn(root, cold.sessions, child, "snapshot-child", { noTools: true, input: 400 })
  assert.equal(forbidden.length, 0)
  const state = yield* audit(root, cold.log, child)
  assert.ok(!state.events.some((event) => event.data.runId === "snapshot-future-publication"))
  yield* media.put(bytesB)
  return { calls: current.calls, oldAnchorFuturePublicationVerified: true, forkCutoffVerified: true, missingFutureMediaIgnored: true, replayVerified: true }
}))
const holder = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions } = yield* build(root, { decorate: (inner) => SessionLog.of({ ...inner, commit: (id, input) => inner.commit(id, input).pipe(Effect.tap((committed) => input.events.some((event) => event.kind === "memory.snapshot") ? Effect.gen(function* () {
    const snapshot = committed.events.find((event) => event.kind === "memory.snapshot")
    const pointer = input.state.value.sessions.memorySnapshot
    assert.deepEqual(pointer, { session: id, seq: snapshot.seq }, "snapshot and pointer were not in the same submitted commit")
    yield* say(`ack ${JSON.stringify({ revision: committed.revision, seq: committed.seq, snapshot: snapshot.seq })}`)
    yield* say("snapshot-ack-held")
    yield* Effect.never
  }) : Effect.void)) }) })
  return yield* runTurn(root, sessions, parent, "snapshot-held", { noTools: true, input: 2_000 })
}))
const inspect = (root) => Effect.scoped(Effect.gen(function* () {
  const { log } = yield* build(root)
  const state = yield* audit(root, log, parent)
  assert.equal(state.snapshots.length, 1)
  assert.equal(state.events.filter((event) => event.kind === "turn.ended" && event.turn.value === 2).length, 0)
  return { revision: state.head.revision, seq: state.head.seq, snapshot: state.snapshots[0].event.seq, durablePointerBeforeAckVerified: true }
}))
const recover = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions, log } = yield* build(root)
  const done = yield* runTurn(root, sessions, parent, "snapshot-recovered", { noTools: true, input: 400, resume: true, probe: true })
  const state = yield* audit(root, log, parent)
  assert.equal(state.snapshots.length, 1, "takeover republished an already durable checkpoint")
  const endings = yield* readStored("turn.ended", state.events)
  assert.ok(endings.some(({ data }) => Option.exists(data.failure, (failure) => failure.code === "turn.takeover")))
  return { ...done, heldAckRecoveryVerified: true, replayVerified: true }
}))
const kits = () => Effect.gen(function* () {
  const checks = memorySnapshotConformance()
  yield* Effect.forEach(checks, (check) => check.run, { concurrency: 1 })
  return { checks: checks.length, kitVerified: true }
})

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
  const root = await mkdtemp(join(tmpdir(), "efferent-snapshots-"))
  const children = new Set()
  const deadline = { timer: undefined }
  try {
    await Promise.race([(async () => {
      const storage = join(root, "main")
      const kit = await startChild("kits", root, children).done()
      await startChild("seed", storage, children).done()
      const summarized = await startChild("summarize", storage, children).done()
      const cold = await startChild("reopen", storage, children).done()
      const fork = await startChild("fork", storage, children).done()
      const heldStorage = join(root, "held")
      await startChild("seed", heldStorage, children).done()
      const held = startChild("holder", heldStorage, children)
      await held.waitFor("snapshot-ack-held")
      const checkpoint = held.checkpoint("ack ")
      const durable = await startChild("inspect", heldStorage, children).done()
      assert.deepEqual(checkpoint, { revision: durable.revision, seq: durable.seq, snapshot: durable.snapshot })
      await held.kill()
      assert.equal(held.output.errors, "")
      const recovered = await startChild("recover", heldStorage, children).done()
      console.log(`memory-snapshot ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", kit, summary: summarized, cold, fork, held: { ...durable, ...recovered } })}`)
    })(), new Promise((_, reject) => { deadline.timer = setTimeout(() => reject(new Error("the snapshot controller deadline elapsed")), 55_000) })])
  } finally {
    clearTimeout(deadline.timer)
    await Promise.all([...children].map((child) => new Promise((resolve) => { child.once("close", resolve); child.kill("SIGKILL") })))
    await rm(root, { recursive: true, force: true })
  }
}
const report = (value) => say(`result ${JSON.stringify(value)}`)
const watchdog = setTimeout(() => { console.error(`snapshot fixture timed out in ${mode}`); process.exit(2) }, 65_000)
if (mode === "journey") watchdog.unref()
try {
  if (mode === "journey") await journey()
  else {
    const work = mode === "kits" ? kits() : mode === "seed" ? seed(directory) : mode === "summarize" ? summarize(directory) : mode === "reopen" ? reopen(directory)
      : mode === "fork" ? forks(directory) : mode === "holder" ? holder(directory) : mode === "inspect" ? inspect(directory)
        : mode === "recover" ? recover(directory) : Effect.die(`unknown snapshot fixture mode ${mode}`)
    await Effect.runPromise(work.pipe(Effect.flatMap(report), Effect.timeout("25 seconds")))
  }
} finally { clearTimeout(watchdog) }
