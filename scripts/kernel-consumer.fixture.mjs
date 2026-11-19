import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Context, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { assistantMessage, Core, inspectionOf, JournalStorage, journalStorageConformance, kernel, ModelSpend, modelSpendMemory, Sessions, sessionsConformance, userMessage } from "@xandreed/core/kernel"
import { callTool, Embedder, embedderConformance, Files, filesConformance, filesSearch, flatMemory, Inbox, inbox, inMemoryFiles, inMemoryVectors, inProcessJournal, Memory, memoryConformance, modelAnswer, recordedEmbedder, recoverTurns, scriptedModel, Search, searchConformance, sessions, Shell, shellConformance, VectorStore, vectorStoreConformance, webStorageJournal, windowMemory } from "@xandreed/sdk/kernel"
import { anthropicModel, directoryJournal, diskFiles, isSpendRefusal, openAiCompatibleModel, processShell, sqliteJournal } from "@xandreed/sdk/kernel/node"

const system = "You are a kit."
const budgetTokens = 200
const onCore = (core) => Layer.succeed(Core, core)
/** Build a plugin's layer over the services given and take the contract it provides. */
const built = (key, layer, over) =>
  Effect.map(Effect.orDie(Layer.build(Layer.provide(layer, over))), (services) => Context.get(services, key))

/** What a browser's `localStorage` is to the web storage journal: strings by key. */
const memoryStore = () => {
  const values = new Map()
  return {
    get length() { return values.size },
    key: (index) => Array.from(values.keys())[index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}
const webOver = (store) => built(JournalStorage, webStorageJournal(store, { prefix: "consumer:" }), Layer.empty)
/** The session plugin over a store, and that store: what the sessions kit asks for. */
const sessionsOver = (core, store) => Effect.flatMap(built(JournalStorage, store, Layer.empty), (storage) =>
  Effect.map(built(Sessions, sessions(), Layer.merge(onCore(core), Layer.succeed(JournalStorage, storage))), (all) => ({ sessions: all, storage })))

/** Where the durable journals of this run are kept: one folder, removed when the process exits. */
const scratch = mkdtempSync(join(tmpdir(), "kernel-consumer-"))
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }))
let made = 0
/** A path under the scratch folder no store has used. */
const fresh = (file) => join(scratch, `store-${++made}`, file)
/** The two durable journals of the Node entry, each over a path: a directory of files, and a SQLite file (`bun:sqlite` on Bun, `node:sqlite` on Node). */
const durable = {
  directory: { file: "journal", layer: (path) => directoryJournal({ directory: path }) },
  sqlite: { file: "journal.db", layer: (path) => sqliteJournal({ path }) },
}
const durableOver = (kind, path) => built(JournalStorage, durable[kind].layer(path), Layer.empty)
/** The storage kit's subject over a durable journal: a fresh path per check, and two handles of this process on one path. */
const durableSubject = (kind) => ({
  open: Effect.suspend(() => durableOver(kind, fresh(durable[kind].file))),
  pair: Effect.suspend(() => { const path = fresh(durable[kind].file); return Effect.all([durableOver(kind, path), durableOver(kind, path)], { concurrency: 1 }) }),
})

/** A fresh folder under the scratch folder, by its real path (what `pwd -P` prints). */
const folder = () => { const path = fresh("workspace"); mkdirSync(path, { recursive: true }); return realpathSync(path) }
/** The workspace's ports of the Node entry (ADR 0028): a folder of the disk, the search over it, and a shell. */
const shellEnv = { KIT_GIVEN: "given value", PATH: "/usr/bin:/bin" }
const shellFolder = folder()
const workspaceKits = {
  diskFiles: filesConformance({ open: Effect.suspend(() => built(Files, diskFiles({ root: folder() }), Layer.empty)) }),
  diskSearch: searchConformance({
    open: (files) => Effect.suspend(() => {
      const root = folder()
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), text)
      }
      return built(Search, filesSearch, diskFiles({ root }))
    }),
  }),
  processShell: shellConformance({ open: built(Shell, processShell({ cwd: shellFolder, env: shellEnv, outputBytes: 1000 }), Layer.empty), folder: shellFolder, env: shellEnv, outputBytes: 1000 }),
}

const kits = {
  storage: journalStorageConformance({ open: built(JournalStorage, inProcessJournal(), Layer.empty) }),
  // A store that outlives its handle is also asked what a second handle on the same storage reads.
  webStorage: journalStorageConformance({
    open: Effect.suspend(() => webOver(memoryStore())),
    pair: Effect.suspend(() => { const store = memoryStore(); return Effect.all([webOver(store), webOver(store)], { concurrency: 1 }) }),
  }),
  sessions: sessionsConformance({ open: (core) => sessionsOver(core, inProcessJournal()) }),
  sessionsOverWebStorage: sessionsConformance({ open: (core) => sessionsOver(core, webStorageJournal(memoryStore(), { prefix: "consumer:" })) }),
  memory: memoryConformance({ name: "window", budgetTokens, open: (core) => built(Memory, windowMemory({ budgetTokens }), onCore(core)) }),
  flatMemory: memoryConformance({ name: "flat", open: (core) => built(Memory, flatMemory, onCore(core)) }),
  files: filesConformance({ open: built(Files, inMemoryFiles(), Layer.empty) }),
  embedder: embedderConformance({
    texts: ["a cat", "a stock price", "a lemon cake"],
    open: built(Embedder, recordedEmbedder({
      model: "consumer",
      vectors: { query: { "a cat": [1, 0, 0], "a stock price": [0, 1, 0], "a lemon cake": [0, 0, 1] }, passage: { "a cat": [1, 0, 0.5], "a stock price": [0, 1, 0.5], "a lemon cake": [0, 0.5, 1] } },
    }), Layer.empty),
  }),
  vectors: vectorStoreConformance({ open: built(VectorStore, inMemoryVectors(), Layer.empty) }),
  directoryStorage: journalStorageConformance(durableSubject("directory")),
  sqliteStorage: journalStorageConformance(durableSubject("sqlite")),
  sessionsOverDirectory: sessionsConformance({ open: (core) => sessionsOver(core, durable.directory.layer(fresh("journal"))) }),
  sessionsOverSqlite: sessionsConformance({ open: (core) => sessionsOver(core, durable.sqlite.layer(fresh("journal.db"))) }),
  ...workspaceKits,
}
/** Run a kit's checks one after another: how many ran, and what each failure said. */
const run = (checks) => Effect.runPromise(Effect.forEach(checks, (check) => Effect.map(Effect.result(check.run), (result) =>
  result._tag === "Failure" ? [`${check.id}: ${result.failure.message}`] : []), { concurrency: 1 }).pipe(
  Effect.map((failed) => ({ checks: checks.length, failed: failed.flat() })),
  Effect.timeout("60 seconds"),
))

const ran = {}
for (const [name, checks] of Object.entries(kits)) {
  ran[name] = await run(checks)
  assert.deepEqual(ran[name].failed, [], `the ${name} kit failed on its stock plugin`)
  assert.ok(ran[name].checks >= 5, `the ${name} kit ran ${ran[name].checks} checks`)
}

/** A host's own turn: open it, store the message, ask memory for the context, call the model, store the answer. */
const turnOf = (conversation, message) => Effect.scoped(Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(conversation)
  yield* session.append(userMessage(message))
  const history = yield* (yield* Memory).context(session)
  const model = yield* LanguageModel.LanguageModel
  const answer = yield* model.streamText({ prompt: Prompt.make([{ role: "system", content: system }, ...history]) }).pipe(
    Stream.tap((part) => (part.type === "error" ? Effect.fail(part.error) : Effect.void)),
    Stream.filter((part) => part.type === "text-delta"),
    Stream.map((part) => part.delta),
    Stream.mkString,
  )
  yield* session.append(assistantMessage(answer))
  return answer
}))

/** The stock parts over a model, composed as a host composes them. */
const agentOf = (model) => flatMemory.pipe(
  Layer.provideMerge(sessions()),
  Layer.provideMerge(inProcessJournal()),
  Layer.provideMerge(kernel()),
  Layer.provideMerge(model),
)

const turn = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { model, calls } = yield* scriptedModel([{ _tag: "Answers", pieces: ["Hel", "lo!"] }])
  return yield* Effect.gen(function* () {
    const sessionsOf = yield* Sessions
    const session = yield* sessionsOf.create({ owner: "consumer" })
    const reply = yield* turnOf(session, "Hello")
    const journal = yield* sessionsOf.read(session)
    const inspection = yield* Effect.fromResult(inspectionOf(journal))
    const invalid = yield* Effect.flip(sessionsOf.create({ owner: "" }))
    return { reply, invalid, state: inspection.state._tag, names: inspection.events.map((event) => event.name), stored: JSON.stringify(journal.events), calls: yield* calls }
  }).pipe(Effect.provide(agentOf(model)))
})).pipe(Effect.timeout("20 seconds")))
assert.equal(turn.reply, "Hello!")
assert.equal(turn.invalid._tag, "InvalidSession")
assert.equal(turn.state, "Free")
assert.deepEqual(turn.names, [
  "core.session.turn.started",
  "conversation.user.message",
  "conversation.assistant.message",
  "core.session.turn.ended",
])
assert.ok(!turn.stored.includes(system), "the journal holds the system text")
assert.deepEqual(turn.calls, [[{ role: "system", text: system }, { role: "user", text: "Hello" }]])

const queued = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { model } = yield* scriptedModel([{ _tag: "Answers", pieces: ["One."] }, { _tag: "Answers", pieces: ["Two."] }])
  return yield* Effect.gen(function* () {
    const session = yield* (yield* Sessions).create({ owner: "consumer" })
    const entries = yield* Effect.forEach(["First", "Second"], (message) => Effect.flatMap(Inbox, (queue) => queue.enqueue(session, message)), { concurrency: 1 })
    const replies = yield* Effect.forEach(entries, (entry) => entry.reply, { concurrency: 2 })
    return { tickets: entries.map((entry) => entry.ticket), replies }
  }).pipe(Effect.provide(inbox(turnOf).pipe(Layer.provideMerge(agentOf(model)))))
})).pipe(Effect.timeout("20 seconds")))
assert.deepEqual(queued, { tickets: [1, 2], replies: ["One.", "Two."] })

/** A host's turn with tools: Effect AI's Toolkit, offered to the model; each call run by the turn and stored with its result. */
const Add = Tool.make("add", { description: "Add two numbers.", parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }), success: Schema.Number })
const tools = Toolkit.make(Add)
const toolsLive = tools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })
const toolTurnOf = (conversation, message) => Effect.scoped(Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(conversation)
  const toolkit = yield* tools
  yield* session.append(userMessage(message))
  for (let step = 1; step <= 3; step++) {
    const history = yield* (yield* Memory).context(session)
    // The kernel's two functions for a turn's work: one reads the model's answer and stores it, the other runs a call and stores its result.
    const answer = yield* modelAnswer((yield* LanguageModel.LanguageModel).streamText({
      prompt: Prompt.make([{ role: "system", content: system }, ...history]), toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred",
    }), session)
    if (answer.toolCalls.length === 0) return answer.text
    for (const call of answer.toolCalls) {
      yield* callTool(toolkit, call, session)
    }
  }
  return "stopped"
}))
const toolTurn = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { model, calls } = yield* scriptedModel([
    { _tag: "Calls", pieces: [], calls: [{ name: "add", params: { a: 2, b: 3 } }] },
    { _tag: "Answers", pieces: ["It is 5."] },
  ])
  return yield* Effect.gen(function* () {
    const sessionsOf = yield* Sessions
    const session = yield* sessionsOf.create({ owner: "consumer" })
    const reply = yield* toolTurnOf(session, "What is 2 + 3?")
    const journal = yield* sessionsOf.read(session)
    return { reply, names: journal.events.map((event) => event.name), calls: yield* calls }
  }).pipe(Effect.provide(Layer.merge(agentOf(model), toolsLive)))
})).pipe(Effect.timeout("20 seconds")))
assert.equal(toolTurn.reply, "It is 5.")
assert.deepEqual(toolTurn.names, [
  "core.session.turn.started",
  "conversation.user.message",
  "conversation.assistant.message",
  "conversation.tool.result",
  "conversation.assistant.message",
  "core.session.turn.ended",
])
assert.deepEqual(toolTurn.calls[1], [
  { role: "system", text: system },
  { role: "user", text: "What is 2 + 3?" },
  { role: "assistant", text: "add({\"a\":2,\"b\":3})" },
  { role: "tool", text: "→ 5" },
])

/** A journal in a storage that outlives the stack that wrote it: the next stack lists it, closes the turn left open, and goes on. */
const kept = memoryStore()
const durableOf = () => sessions().pipe(Layer.provideMerge(webStorageJournal(kept, { prefix: "consumer:" })), Layer.provideMerge(kernel()))
const left = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const sessionsOf = yield* Sessions
  const session = yield* sessionsOf.create({ owner: "consumer" })
  yield* sessionsOf.turn(session, (open) => open.append(userMessage("Kept.")))
  // A writer that is gone: the start of a turn in the storage, and no end.
  kept.setItem(`consumer:${session}:4`, kept.getItem(`consumer:${session}:1`).replace('"seq":1', '"seq":4').replace(/"turn":1/g, '"turn":2'))
  return session
}).pipe(Effect.provide(durableOf()))).pipe(Effect.timeout("20 seconds")))
const resumed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const sessionsOf = yield* Sessions
  const listed = yield* sessionsOf.list
  const busy = yield* Effect.flip(sessionsOf.turn(left, () => Effect.void))
  const closed = yield* sessionsOf.recover(left)
  const turn = yield* sessionsOf.turn(left, (open) => Effect.succeed(open.turn))
  const journal = yield* sessionsOf.read(left)
  return { listed: listed.map((header) => header.id), busy: busy.reason, closed: closed._tag === "Some" ? closed.value : 0, turn, outcomes: journal.events.filter((event) => event.name === "core.session.turn.ended").map((event) => event.data.outcome._tag) }
}).pipe(Effect.provide(durableOf()))).pipe(Effect.timeout("20 seconds")))
assert.deepEqual(resumed, { listed: [left], busy: "SessionBusy", closed: 2, turn: 3, outcomes: ["Completed", "Abandoned", "Completed"] })

/**
 * A process over a durable journal, run by this runtime from the packed packages: it creates a session, opens a
 * turn, stores a message and waits inside the turn; or, refused the store, says why and waits. Its first line says
 * which.
 */
const holderScript = (kind, path) => `
import { Effect, Layer } from "effect"
import { kernel, Sessions, userMessage } from "@xandreed/core/kernel"
import { sessions } from "@xandreed/sdk/kernel"
import { anthropicModel, directoryJournal, isSpendRefusal, openAiCompatibleModel, sqliteJournal } from "@xandreed/sdk/kernel/node"
const store = ${kind === "sqlite" ? "sqliteJournal({ path: " + JSON.stringify(path) + " })" : "directoryJournal({ directory: " + JSON.stringify(path) + " })"}
const say = (value) => Effect.sync(() => { process.stdout.write(JSON.stringify(value) + "\\n") })
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const all = yield* Sessions
  const session = yield* all.create({ owner: "holder" })
  yield* all.turn(session, (open) => Effect.andThen(open.append(userMessage("Are you there?")), Effect.andThen(say({ session }), Effect.never)))
}).pipe(
  Effect.provide(sessions().pipe(Layer.provideMerge(store), Layer.provideMerge(kernel()))),
  Effect.catchTag("JournalOpenFailed", (failed) => Effect.andThen(say({ refused: failed.reason }), Effect.never)),
)))
`
const spawnHolder = (kind, path) => new Promise((resolve, reject) => {
  const script = holderScript(kind, path)
  const child = spawn(process.execPath, typeof Bun === "undefined" ? ["--input-type=module", "-e", script] : ["-e", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] })
  let out = ""
  child.stdout.on("data", (chunk) => {
    out += chunk
    if (out.includes("\n")) resolve({ child, line: JSON.parse(out.slice(0, out.indexOf("\n"))) })
  })
  child.once("exit", (code) => reject(new Error(`the holder process exited with ${code} before it said what it holds`)))
})
/** Kill a process as a crash does: no finalizer of its runs. */
const kill = (child) => new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGKILL") })

/**
 * A process killed inside a turn, on each durable journal: the next process takes the store over (its holder is
 * gone), closes the turn as abandoned with `recoverTurns`, and takes a new turn; while it holds the store, a third
 * process is refused.
 */
const crashes = {}
for (const kind of Object.keys(durable)) {
  const path = fresh(durable[kind].file)
  const { child, line } = await spawnHolder(kind, path)
  assert.ok(typeof line.session === "string", `the ${kind} holder said ${JSON.stringify(line)}`)
  await kill(child)
  crashes[kind] = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { closed, unreadable } = yield* recoverTurns
    const sessionsOf = yield* Sessions
    const turn = yield* sessionsOf.turn(line.session, (open) => Effect.succeed(open.turn))
    const second = yield* Effect.promise(() => spawnHolder(kind, path))
    yield* Effect.promise(() => kill(second.child))
    const journal = yield* sessionsOf.read(line.session)
    return { closed: closed.map((one) => [one.session === line.session, one.turn]), unreadable, turn, refused: second.line.refused, outcomes: journal.events.filter((event) => event.name === "core.session.turn.ended").map((event) => event.data.outcome._tag) }
  }).pipe(Effect.provide(sessions().pipe(Layer.provideMerge(durable[kind].layer(path)), Layer.provideMerge(kernel()))))).pipe(Effect.timeout("30 seconds")))
  assert.deepEqual(crashes[kind], { closed: [[true, 1]], unreadable: [], turn: 2, refused: "Held", outcomes: ["Abandoned", "Completed"] }, `the ${kind} journal after a crash`)
}

class Notes extends Context.Service()("consumer/Notes") {}
const notes = Layer.succeed(Notes, { of: (text) => `noted: ${text}` })
const composed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const seen = []
  const reads = Layer.effectDiscard(Effect.map(Notes, (provided) => { seen.push(provided.of("built")) }))
  yield* Layer.build(reads.pipe(Layer.provideMerge(notes)))
  return { seen }
})).pipe(Effect.timeout("20 seconds")))
assert.deepEqual(composed.seen, ["noted: built"])

/**
 * The Node entry's model providers, one streamed call each over a local HTTP server that answers as the provider's
 * stream does, each charging a ledger: settled at the usage reported, a call over the ledger's cap refused before it
 * is sent, and a call to a closed port released.
 */
const sseOf = (events) => events.map((event) => `${event.type === undefined ? "" : `event: ${event.type}\n`}data: ${JSON.stringify(event)}\n\n`).join("")
const served = []
const server = createServer((request, response) => {
  let body = ""
  request.on("data", (chunk) => { body += chunk })
  request.on("end", () => {
    served.push(request.url)
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(request.url.startsWith("/v1/chat/completions")
      ? `${sseOf([{ choices: [{ delta: { content: "Hello" } }] }, { choices: [{ delta: { content: "!" }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }])}data: [DONE]\n\n`
      : sseOf([
        { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello!" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ]))
  })
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${server.address().port}`
const spendOf = (model, caps = {}) => ({ prices: { [model]: { input: 1, output: 5 } }, caps })
const callOver = (layer) => Effect.runPromise(Effect.gen(function* () {
  const result = yield* Effect.result(Stream.runCollect(LanguageModel.streamText({ prompt: "Hi" })))
  const totals = yield* (yield* ModelSpend).totals
  return result._tag === "Failure"
    ? { refused: isSpendRefusal(result.failure), totals }
    : { text: result.success.filter((part) => part.type === "text-delta").map((part) => part.delta).join(""), totals }
}).pipe(Effect.provide(Layer.provideMerge(layer, modelSpendMemory)), Effect.timeout("20 seconds")))
const providers = {
  openAiCompatible: await callOver(openAiCompatibleModel({ model: "m", baseUrl: `${base}/v1`, apiKey: Redacted.make("k"), maxOutputTokens: 100, spend: spendOf("m") })),
  anthropic: await callOver(anthropicModel({ model: "claude", baseUrl: base, apiKey: Redacted.make("k"), maxOutputTokens: 100, spend: spendOf("claude") })),
  overCap: await callOver(openAiCompatibleModel({ model: "m", baseUrl: `${base}/v1`, maxOutputTokens: 100, spend: spendOf("m", { total: 0.0001 }) })),
}
server.close()
// A port that was opened and closed: the connection is refused before the request leaves, and the hold is released.
const closed = createServer()
await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve))
const closedPort = closed.address().port
await new Promise((resolve) => closed.close(resolve))
providers.connectionRefused = await callOver(openAiCompatibleModel({ model: "m", baseUrl: `http://127.0.0.1:${closedPort}/v1`, maxOutputTokens: 100, spend: spendOf("m") }))
assert.deepEqual(providers, {
  openAiCompatible: { text: "Hello!", totals: { settled: (10 * 1 + 2 * 5) / 1_000_000, reserved: 0 } },
  anthropic: { text: "Hello!", totals: { settled: (10 * 1 + 2 * 5) / 1_000_000, reserved: 0 } },
  overCap: { refused: true, totals: { settled: 0, reserved: 0 } },
  connectionRefused: { refused: false, totals: { settled: 0, reserved: 0 } },
})
assert.deepEqual(served, ["/v1/chat/completions", "/v1/messages"])

console.log(`kernel ${JSON.stringify({
  runtime: typeof Bun === "undefined" ? "Node" : "Bun",
  storageKit: true,
  sessionsKit: true,
  memoryKit: true,
  hostTurn: true,
  inboxQueued: true,
  toolTurn: true,
  storeOutlives: true,
  durableKits: true,
  crashRecovered: true,
  layersComposed: true,
  modelProviders: true,
  workspaceKits: true,
  checks: Object.fromEntries(Object.entries(ran).map(([name, kit]) => [name, kit.checks])),
})}`)
