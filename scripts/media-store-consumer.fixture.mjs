/** Key-free real files/process evidence; responses are scripted, not live providers. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool } from "effect/ai"
import {
  canonicalJson, ConversationId, defineCapability, defineSkill, defineTool,
  describeModel, entriesOfEvents, Failure, frameworkDraft,
  InboxItemId, isMediaValue, journalSchemaOf, mediaFromBase64, mediaFromBytes,
  mediaHashOf, MediaStore, MediaStoreMemoryLive, replayModelRequest, RunId,
  RunOrdinal, SessionLog, Sessions, STORED_FORMAT, TurnAdmissionOpen, TurnMemory,
  UserMessage, withMediaStore,
} from "@xandreed/core"
import { mediaStoreConformance, sessionLogConformance } from "@xandreed/core/conformance"
import { prepareRequestParts, toolParametersSchema } from "@xandreed/core/internal"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { MediaStoreDirectoryLive, nodeFilesIo, SessionLogFilesLive } from "@xandreed/plugin-session-files"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "@xandreed/sdk"

const self = fileURLToPath(import.meta.url)
const mode = process.argv[2] ?? "journey"
const directory = process.argv[3]
const owner = "media-store-fixture"
const parent = { id: ConversationId.make("00000000-0000-4000-8000-000000002201"), owner }
const child = { id: ConversationId.make("00000000-0000-4000-8000-000000002202"), owner }
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const bytesA = new Uint8Array(Buffer.from(pixel, "base64"))
const bytesB = Uint8Array.from(bytesA, (byte, index) => index === bytesA.length - 1 ? byte ^ 1 : byte)
const imageA = await Effect.runPromise(mediaFromBase64(pixel, { name: "attachment.png", alt: "A one-pixel checkpoint." }))
const imageB = await Effect.runPromise(mediaFromBytes(bytesB, { name: "later.png", alt: "A later checkpoint." }))
const hashA = mediaHashOf(bytesA)
assert.equal(hashA, createHash("sha256").update(bytesA).digest("hex"))
const query = { after: 0, limit: Option.none(), kinds: [] }
const say = (line) => Effect.sync(() => process.stdout.write(`${line}\n`))
const finish = (reason) => ({ type: "finish", reason, usage: { inputTokens: { total: 8 }, outputTokens: { total: 3 } } })
const Probe = Tool.make("media_checkpoint", { description: "Return an image checkpoint.", parameters: Tool.EmptyParams, success: Schema.Json, failure: Failure, failureMode: "return" })
const literal = { "$efferent.media": { version: 1, value: { data: { type: "media-reference", version: 1, hash: "f".repeat(64) } }, paths: [["data"]] } }
const payload = (image) => ({ nested: [{ deeper: { ...image, name: "tool.png", alt: "Tool checkpoint.", business: { kept: [1, "two"] } } }], invalid: { ...image, data: `${image.data} ` }, literal })
const compose = (handler) => Agent.define({
  plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin],
  capabilities: [defineCapability({ id: "media-store-fixture", version: "1", tools: [defineTool({ tool: Probe, handler, annotations: { readOnly: true } })],
    skills: [defineSkill({ id: "media-store-fixture", summary: "Use the image checkpoint.", always: true, tools: [Probe.name] })] })],
  system: "Preserve the media checkpoint.", turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 3 },
})
const build = (root, options = {}) => Effect.gen(function* () {
  const files = yield* Layer.build(SessionLogFilesLive(join(root, "sessions")))
  const raw = Context.get(files, SessionLog)
  const mediaLayer = MediaStoreDirectoryLive(join(root, "media"), { ...(options.mediaIo ? { io: options.mediaIo } : {}), stallMs: 60_000 })
  const media = Context.get(yield* Layer.build(mediaLayer), MediaStore)
  const inner = options.decorate ? options.decorate(raw) : raw
  const log = options.inline ? inner : yield* withMediaStore(inner).pipe(Effect.provideService(MediaStore, media))
  const services = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 120_000, renew: "on-commit" } }).pipe(
    Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)),
  ))
  return { sessions: Context.get(services, Sessions), raw, log, media }
})
const visible = (log, address, through) => Effect.gen(function* () {
  const head = yield* log.head(address.id)
  const inherited = yield* Option.match(head.header.parent, { onNone: () => Effect.succeed([]), onSome: (lineage) => visible(log, { id: lineage.id, owner }, lineage.through) })
  return [...inherited, ...yield* log.read(address.id, { ...query, ...(through === undefined ? {} : { through }) })]
})
const runTurn = (sessions, address, runName, options = {}) => Effect.gen(function* () {
  const observed = options.observed ?? []
  const image = options.image ?? imageA
  const handlers = yield* Ref.make(0)
  const agent = yield* compose(() => Ref.update(handlers, (count) => count + 1).pipe(Effect.as(payload(image))))
  const model = describeModel(yield* LanguageModel.make({
    generateText: (call) => Effect.gen(function* () {
      observed.push({ runId: runName, index: observed.length, prompt: yield* Schema.encodeEffect(Prompt.Prompt)(call.prompt), tools: call.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: toolParametersSchema(tool) })) })
      assert.ok(!options.forbid, "a corrupt/missing or unacknowledged media dependency reached the model")
      if (observed.length > 1) return [{ type: "text", text: "Media checkpoint complete." }, finish("stop")]
      return [
        { type: "tool-call", id: `${runName}-provider`, name: Probe.name, params: {}, providerExecuted: true },
        { type: "tool-result", id: `${runName}-provider`, name: Probe.name, result: { provider: [{ ...image, name: "provider.png" }] }, isFailure: false, providerExecuted: true },
        { type: "tool-call", id: `${runName}-local`, name: Probe.name, params: {}, providerExecuted: false }, finish("tool-calls"),
      ]
    }), streamText: () => Stream.die("the media fixture does not stream"),
  }), { provider: "fixture", model: "media", settings: {} })
  const turn = options.queued ? yield* sessions.begin(address, { _tag: "Queued", input: InboxItemId.make("queued-image"), runId: RunId.make(runName) })
    : { session: address, runId: RunId.make(runName), userMessage: new UserMessage({ text: `Inspect image checkpoint ${runName}.`, attachments: [image] }), command: { nested: [image] }, ...(options.resume ? { resumes: 1, takeOver: true } : {}) }
  const result = yield* agent.turn({ turn, services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model)) }, (turn) => Effect.gen(function* () {
    yield* turn.tools.select(turn.userMessage)
    const done = yield* turn.run({})
    return { outcome: done.outcome, reply: Option.some(done.text) }
  }))
  assert.equal(yield* Ref.get(handlers), 1)
  assert.equal(observed.length, 2)
  return { result, observed, handlers: yield* Ref.get(handlers) }
})
const saveCalls = (root, calls) => Effect.tryPromise(async () => {
  const file = join(root, "captured.json")
  const old = await readFile(file, "utf8").then(JSON.parse).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error))
  await writeFile(file, JSON.stringify([...old, ...calls]))
})
const audit = (root, log, address) => Effect.gen(function* () {
  const events = yield* visible(log, address)
  yield* Effect.forEach(events, (event) => Option.match(journalSchemaOf(event.kind), { onNone: () => Effect.void, onSome: (schema) => Schema.decodeUnknownEffect(schema)(event.data) }), { concurrency: 1, discard: true })
  yield* entriesOfEvents(events)
  const calls = yield* Effect.tryPromise(() => readFile(join(root, "captured.json"), "utf8").then(JSON.parse))
  const headers = events.filter((event) => event.kind === "request.prepared")
  const materialized = yield* Effect.forEach(headers, (event) => Effect.gen(function* () {
    const request = yield* replayModelRequest(events.slice(0, events.indexOf(event) + 1), RunId.make(event.data.runId), event.data.step, RunOrdinal.make(event.data.run ?? 0))
    const actual = calls.find((call) => call.runId === event.data.runId && call.index === event.data.step)
    if (actual) {
      assert.deepEqual(yield* Schema.encodeEffect(Prompt.Prompt)(request.prompt), actual.prompt)
      assert.deepEqual(request.tools.map(({ name, description, parameters }) => ({ name, description, parameters })), actual.tools)
    }
    return request
  }), { concurrency: 1 })
  assert.ok(headers.length > 0)
  assert.equal((yield* log.head(address.id)).state.sessions.format, STORED_FORMAT)
  return { events, headers, materialized }
})
const seedPart = (sessions) => Effect.gen(function* () {
  const writer = yield* sessions.begin(parent, { _tag: "User", runId: RunId.make("media-synthetic-part"), key: "media-synthetic-part", command: {}, userMessage: new UserMessage({ text: "Synthetic media-bearing schema checkpoint." }) })
  const agent = yield* compose(() => Effect.die("the synthetic schema checkpoint must not run tools"))
  const neverCalled = yield* LanguageModel.make({ generateText: () => Effect.die("the synthetic schema checkpoint must not dispatch"), streamText: () => Stream.die("not scripted") })
  yield* agent.turn({ turn: writer, services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, neverCalled)) }, () => Effect.gen(function* () {
    const memory = yield* TurnMemory
    const run = yield* memory.startRun
    const built = yield* memory.session.build({ run: run.ordinal, stepContext: "none" })
    const plan = yield* prepareRequestParts({ version: 1, runId: run.id, run: run.ordinal, step: 0, strategyVersion: memory.strategy.version,
      system: "Synthetic unused media schema.", render: yield* memory.session.renderRecipe("none", run.ordinal), through: built.through, contextFingerprint: built.fingerprint,
      tools: [{ name: "synthetic_media_schema", description: "Synthetic schema.", parameters: { type: "object", properties: { image: { default: imageA } } }, provider: Option.none() }],
      toolChoice: "auto", model: Option.none(), cacheKey: Option.none(), callPolicy: Option.none() })
    yield* writer.append([...plan.parts.map((part) => frameworkDraft("request.part", part)), frameworkDraft("request.prepared", plan.header)])
    yield* writer.flush
    return { outcome: "completed", reply: Option.some("Synthetic media schema checkpoint complete.") }
  }))
  yield* writer.end({ reason: "completed", failure: Option.none() })
})
const stable = (root) => Effect.scoped(Effect.gen(function* () {
  const legacy = yield* build(root, { inline: true })
  yield* legacy.sessions.create(parent)
  const inline = yield* runTurn(legacy.sessions, parent, "media-inline-legacy")
  yield* saveCalls(root, inline.observed)
  const { sessions, raw, log } = yield* build(root)
  yield* seedPart(sessions)
  const first = yield* runTurn(sessions, parent, "media-first")
  yield* saveCalls(root, first.observed)
  yield* sessions.enqueue(parent, { id: InboxItemId.make("queued-image"), delivery: "next", source: { channel: "media-fixture" }, userMessage: new UserMessage({ text: "Inspect the queued image.", attachments: [{ ...imageA, name: "queued.png" }] }) })
  const queued = yield* runTurn(sessions, parent, "media-queued", { queued: true })
  yield* saveCalls(root, queued.observed)
  const state = yield* audit(root, log, parent)
  const physical = yield* raw.read(parent.id, query)
  const wrapped = physical.filter((event) => Object.hasOwn(event.data, "$efferent.media"))
  assert.ok(wrapped.some((event) => event.kind === "turn.started"))
  assert.ok(wrapped.some((event) => event.kind === "inbox.queued"))
  assert.ok(wrapped.some((event) => event.kind === "memory.tool-result"))
  assert.ok(wrapped.some((event) => event.kind === "memory.message"))
  assert.ok(wrapped.some((event) => event.kind === "request.part"), "media-bearing part was not physically dehydrated")
  const physicalRun = (kind, runId) => wrapped.find((event) => event.kind === kind && event.data["$efferent.media"].value.runId === runId)
  const assertPath = (event, path) => {
    assert.ok(event, `missing physical event for ${JSON.stringify(path)}`)
    const envelope = event.data["$efferent.media"]
    assert.ok(envelope.paths.some((actual) => canonicalJson(actual) === canonicalJson(path)), `media path was not offloaded: ${JSON.stringify(path)}`)
    const ref = path.reduce((value, key) => value[key], envelope.value)
    assert.deepEqual(ref, { type: "media-reference", version: 1, hash: hashA })
    assert.ok(!isMediaValue(ref))
    assert.ok(!isMediaValue(path.slice(0, -1).reduce((value, key) => value[key], envelope.value)))
  }
  const started = physicalRun("turn.started", "media-first")
  assertPath(started, ["userMessage", "attachments", 0, "data"])
  assertPath(started, ["command", "nested", 0, "data"])
  assertPath(wrapped.find((event) => event.kind === "inbox.queued" && event.data["$efferent.media"].value.id === "queued-image"), ["input", "userMessage", "attachments", 0, "data"])
  assertPath(physicalRun("memory.tool-result", "media-first"), ["body", "encoded", "nested", 0, "deeper", "data"])
  const provider = physicalRun("memory.message", "media-first")
  const providerIndex = provider.data["$efferent.media"].value.body.message.content.findIndex((part) => part.type === "tool-result" && part.providerExecuted)
  assert.ok(providerIndex >= 0, "provider result was not recorded in the assistant message")
  assertPath(provider, ["body", "message", "content", providerIndex, "output", "provider", 0, "data"])
  assertPath(wrapped.find((event) => event.kind === "request.part" && event.data["$efferent.media"].value.part._tag === "Tool"), ["part", "tool", "parameters", "properties", "image", "default", "data"])
  const dataReferences = (value) => typeof value === "object" && value !== null ? [value, ...Object.values(value).flatMap(dataReferences)] : []
  const refs = wrapped.flatMap((event) => dataReferences(event.data)).filter((value) => value.type === "media-reference" && value.hash === hashA)
  assert.ok(refs.length >= 8)
  assert.ok(refs.every((ref) => !isMediaValue(ref)))
  const result = state.events.find((event) => event.kind === "memory.tool-result" && event.data.runId === "media-first")
  assert.deepEqual(result.data.body.encoded, payload(imageA))
  assert.ok(state.events.some((event) => event.kind === "turn.started" && !Object.hasOwn(physical.find((row) => row.seq === event.seq).data, "$efferent.media")), "old inline history disappeared")
  assert.deepEqual((yield* Effect.tryPromise(() => readdir(join(root, "media", "blobs")))).filter((name) => name.endsWith(".bin")), [`${hashA}.bin`])
  return { calls: first.observed.length + queued.observed.length, references: refs.length, blobs: 1, dedupVerified: true, coverageVerified: true, logicalHashReplayVerified: true, legacyInlineVerified: true, literalExtrasVerified: true }
}))
const restart = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions, log, raw } = yield* build(root)
  const before = (yield* raw.head(parent.id)).seq
  yield* audit(root, log, parent)
  assert.equal((yield* raw.head(parent.id)).seq, before)
  const current = yield* runTurn(sessions, parent, "media-cold")
  yield* saveCalls(root, current.observed)
  yield* audit(root, log, parent)
  return { coldRestartVerified: true, replayVerified: true, noRewriteVerified: true }
}))
const forks = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions, log, media } = yield* build(root)
  yield* sessions.fork(parent, { id: child.id, origin: "media-fixture", inherit: true })
  const later = yield* runTurn(sessions, parent, "media-parent-later", { image: imageB })
  yield* saveCalls(root, later.observed)
  const laterHash = mediaHashOf(bytesB)
  yield* Effect.tryPromise(() => unlink(join(root, "media", "blobs", `${laterHash}.bin`)))
  const cold = yield* build(root)
  const childRun = yield* runTurn(cold.sessions, child, "media-child")
  yield* saveCalls(root, childRun.observed)
  const state = yield* audit(root, cold.log, child)
  assert.ok(!state.events.some((event) => event.data.runId === "media-parent-later"), "child inherited post-fork media")
  yield* media.put(bytesB)
  yield* audit(root, log, parent)
  yield* sessions.remove(child)
  assert.ok(Option.isSome(yield* media.get(hashA)), "removing a child deleted shared parent media")
  return { forkCutoffBeforeHydrationVerified: true, missingFutureIgnored: true, sharedBlobRetentionVerified: true, replayVerified: true }
}))
const integrity = (root) => Effect.scoped(Effect.gen(function* () {
  for (const kind of ["missing", "corrupt"]) {
    const path = join(root, "media", "blobs", `${hashA}.bin`)
    if (kind === "missing") yield* Effect.tryPromise(() => unlink(path))
    else yield* Effect.tryPromise(() => writeFile(path, new Uint8Array([1, 2, 3])))
    const { sessions } = yield* build(root)
    const observed = []
    const result = yield* Effect.result(runTurn(sessions, parent, `media-${kind}`, { observed, forbid: true }))
    assert.equal(result._tag, "Failure")
    assert.equal(observed.length, 0)
    assert.equal(result.failure._tag, "SessionLogError", `${kind} media was not a typed storage failure`)
    assert.equal(result.failure.code, "store.decode", `${kind} media was not the selected read failure`)
    yield* Effect.tryPromise(() => writeFile(path, bytesA))
  }
  return { missingNoDispatchVerified: true, corruptNoDispatchVerified: true }
}))
const kits = (root) => Effect.scoped(Effect.gen(function* () {
  const memory = { open: () => Layer.build(MediaStoreMemoryLive).pipe(Effect.map((context) => Context.get(context, MediaStore))) }
  const checks = mediaStoreConformance(memory)
  yield* Effect.forEach(checks, (check) => check.run, { concurrency: 1 })
  const dirs = { open: () => Effect.gen(function* () {
    const path = yield* Effect.tryPromise(() => mkdtemp(join(root, "kit-")))
    return Context.get(yield* Layer.build(MediaStoreDirectoryLive(path)), MediaStore)
  }) }
  yield* Effect.forEach(mediaStoreConformance(dirs), (check) => check.run, { concurrency: 1 })
  const { log } = yield* build(join(root, "decorated"))
  yield* Effect.forEach(sessionLogConformance(log), (check) => check.run, { concurrency: 1 })
  return { mediaChecks: checks.length, sessionChecks: sessionLogConformance(log).length, kitsVerified: true }
}))
const blobHolder = (root, after) => Effect.scoped(Effect.gen(function* () {
  const io = { ...nodeFilesIo, link: async (from, to) => {
    if (!to.endsWith(`${hashA}.bin`)) return nodeFilesIo.link(from, to)
    if (after) await nodeFilesIo.link(from, to)
    process.stdout.write(`blob-${after ? "published" : "temporary"}\n`)
    await new Promise(() => {})
  } }
  const { sessions } = yield* build(root, { mediaIo: io })
  yield* sessions.create(parent)
  return yield* runTurn(sessions, parent, "media-blob-held", { forbid: true })
}))
const inspectBlob = (root, after) => Effect.scoped(Effect.gen(function* () {
  const { raw, media } = yield* build(root)
  assert.equal((yield* raw.read(parent.id, query)).length, 0, "journal referenced a blob before its put ACK")
  assert.equal(Option.isSome(yield* media.get(hashA)), after)
  return { publicationVerified: true, durableBlob: after, noDanglingReference: true }
}))
const ackHolder = (root) => Effect.scoped(Effect.gen(function* () {
  const { sessions } = yield* build(root, { decorate: (inner) => SessionLog.of({ ...inner,
    commit: (id, input) => inner.commit(id, input).pipe(Effect.tap((committed) => input.events.some((event) => event.kind === "request.prepared")
      ? say(`ack ${JSON.stringify({ revision: committed.revision, seq: committed.seq })}`).pipe(Effect.andThen(say("ack-held")), Effect.andThen(Effect.never)) : Effect.void)),
  }) })
  yield* sessions.create(parent)
  return yield* runTurn(sessions, parent, "media-ack-held", { forbid: true })
}))
const inspectAck = (root) => Effect.scoped(Effect.gen(function* () {
  const { raw, log } = yield* build(root)
  const events = yield* log.read(parent.id, query)
  assert.ok(events.some((event) => event.kind === "turn.started" && event.data.userMessage.attachments?.[0].data === pixel))
  assert.equal(events.filter((event) => event.kind === "request.prepared").length, 1)
  assert.equal(events.filter((event) => event.kind === "tool.started" || event.kind === "turn.ended").length, 0)
  const head = yield* raw.head(parent.id)
  return { revision: head.revision, seq: head.seq, durableBeforeAckVerified: true }
}))
const recover = (root, resume) => Effect.scoped(Effect.gen(function* () {
  const { sessions, log } = yield* build(root)
  const run = yield* runTurn(sessions, parent, resume ? "media-ack-recovered" : "media-blob-recovered", { resume })
  yield* saveCalls(root, run.observed)
  yield* audit(root, log, parent)
  return { calls: run.observed.length, handlers: run.handlers, recoveredVerified: true, replayVerified: true }
}))

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
  const root = await mkdtemp(join(tmpdir(), "efferent-media-store-"))
  const children = new Set()
  const deadline = { timer: undefined }
  try {
    await Promise.race([(async () => {
      const storage = join(root, "main")
      const kitResult = await startChild("kits", root, children).done()
      const first = await startChild("stable", storage, children).done()
      const restarted = await startChild("restart", storage, children).done()
      const fork = await startChild("fork", storage, children).done()
      const corrupt = await startChild("integrity", storage, children).done()
      const publication = []
      for (const after of [false, true]) {
        const path = join(root, after ? "published" : "temporary")
        const holder = startChild(after ? "hold-published" : "hold-temporary", path, children)
        await holder.waitFor(after ? "blob-published" : "blob-temporary")
        const checkpoint = await startChild(after ? "inspect-published" : "inspect-temporary", path, children).done()
        await holder.kill()
        assert.equal(holder.output.errors, "")
        const recovered = await startChild("recover-blob", path, children).done()
        publication.push({ ...checkpoint, ...recovered })
      }
      const heldPath = join(root, "ack")
      const holder = startChild("hold-ack", heldPath, children)
      await holder.waitFor("ack-held")
      const checkpoint = holder.checkpoint("ack ")
      const durable = await startChild("inspect-ack", heldPath, children).done()
      assert.deepEqual(checkpoint, { revision: durable.revision, seq: durable.seq })
      await holder.kill()
      assert.equal(holder.output.errors, "")
      const recovered = await startChild("recover-ack", heldPath, children).done()
      console.log(`media-store ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", kits: kitResult, stable: first, restart: restarted, fork, integrity: corrupt, publication, heldAck: { ...durable, ...recovered, heldAckRestartVerified: true } })}`)
    })(), new Promise((_, reject) => { deadline.timer = setTimeout(() => reject(new Error("the media-store controller deadline elapsed")), 55_000) })])
  } finally {
    clearTimeout(deadline.timer)
    await Promise.all([...children].map((child) => new Promise((resolve) => { child.once("close", resolve); child.kill("SIGKILL") })))
    await rm(root, { recursive: true, force: true })
  }
}
const report = (value) => say(`result ${JSON.stringify(value)}`)
const watchdog = setTimeout(() => { console.error(`media-store fixture timed out in ${mode}`); process.exit(2) }, 65_000)
if (mode === "journey") watchdog.unref()
try {
  if (mode === "journey") await journey()
  else {
    const work = mode === "kits" ? kits(directory) : mode === "stable" ? stable(directory) : mode === "restart" ? restart(directory)
      : mode === "fork" ? forks(directory) : mode === "integrity" ? integrity(directory) : mode === "hold-temporary" ? blobHolder(directory, false)
        : mode === "hold-published" ? blobHolder(directory, true) : mode === "inspect-temporary" ? inspectBlob(directory, false)
          : mode === "inspect-published" ? inspectBlob(directory, true) : mode === "recover-blob" ? recover(directory, false)
            : mode === "hold-ack" ? ackHolder(directory) : mode === "inspect-ack" ? inspectAck(directory)
              : mode === "recover-ack" ? recover(directory, true) : Effect.die(`unknown media-store fixture mode ${mode}`)
    await Effect.runPromise(work.pipe(Effect.flatMap(report), Effect.timeout("25 seconds")))
  }
} finally { clearTimeout(watchdog) }
