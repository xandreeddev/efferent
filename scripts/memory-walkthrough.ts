/** Key-free playback: scripted model choices; real files, journal, context and native memory. */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { Clock, Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { EmbeddingModel, LanguageModel, Prompt } from "effect/ai"
import type { Response } from "effect/ai"
import { ConversationId, KNOWLEDGE_EXTRACTION_VERSION, LongTermMemory, MemoryStore, RunId, Sessions, TurnAdmissionOpen, UserMessage, UtilityCompletion, UtilityLlm, entriesOfEvents, knowledgeEngineId, makeKnowledgeIndexMemory, zeroUsage } from "@xandreed/core"
import { Agent } from "@xandreed/sdk"
import { toolParametersSchema } from "@xandreed/core/internal"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { memoryCapturePlugin, memoryDefaults, memoryPlugin } from "@xandreed/plugin-memory"
import { SessionLogFilesLive } from "@xandreed/plugin-session-files"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { localSystemPlugin, workspaceToolsPlugin } from "@xandreed/plugin-workspace"

const io = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: (cause) => new Error("Walkthrough file operation failed", { cause }) })
const usage = { inputTokens: { total: undefined }, outputTokens: { total: 1 } }
const stop = (text: string): ReadonlyArray<Response.PartEncoded> => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]
const call = (id: string, name: string, params: unknown): ReadonlyArray<Response.PartEncoded> => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
const preference = "I prefer concise release summaries."
const owner = "example-user"
const scope = { owner, namespace: "walkthrough", collection: "memory" }
const config = { namespace: scope.namespace, worker: false, review: false, consolidate: false, queryPlanning: false, rerank: false, embeddingDimensions: 2, recallChars: 800, recallLimit: 2 }
const engine = knowledgeEngineId(`memory:${KNOWLEDGE_EXTRACTION_VERSION}`, { model: memoryDefaults.embeddingModel, version: memoryDefaults.embeddingVersion, dimensions: config.embeddingDimensions })
const first = { owner, id: ConversationId.make("00000000-0000-4000-8000-0000000000a1") }
const second = { owner, id: ConversationId.make("00000000-0000-4000-8000-0000000000b1") }

interface Request {
  readonly tools: ReadonlyArray<string>
  readonly definitions: ReadonlyArray<{ readonly name: string; readonly description: string; readonly parameters: unknown }>
  readonly toolChoice: unknown
  readonly responseFormat: string
  readonly prompt: typeof Prompt.Prompt.Encoded
}
type Decision = (step: number, prompt: string) => ReadonlyArray<Response.PartEncoded>

export const runMemoryWalkthrough = Effect.fn("example.memory_walkthrough")(function* (output: string) {
  yield* io(() => mkdir(output, { recursive: true }))
  const root = yield* io(() => mkdtemp(join(output, "run-")))
  const workspace = join(root, "workspace")
  const journal = join(root, "journal")
  yield* io(() => mkdir(workspace, { recursive: true }))
  yield* io(() => writeFile(join(workspace, "deployment.md"), "lane: green\nstatus: draft\n"))
  const log = Array.from({ length: 160 }, (_, index) => `Log record ${String(index + 1).padStart(3, "0")}: normal deployment diagnostic details for service alpha.`).join("\n") + "\nERROR_AT_END: queue worker stopped.\n"
  yield* io(() => writeFile(join(workspace, "build.log"), log))
  const store = yield* makeKnowledgeIndexMemory()
  const embedding = yield* EmbeddingModel.make({ embedMany: ({ inputs }) => Effect.succeed({ results: inputs.map(() => [1, 0]), usage: { inputTokens: undefined } }) })
  const extractions = yield* Ref.make<ReadonlyArray<{ readonly source: string; readonly output: string }>>([])
  const utility = UtilityLlm.of({ complete: (prompt) => {
    const source = /<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? ""
    const at = source.indexOf(preference)
    const span = { start: at, end: at + preference.length, quote: preference }
    const extraction = at < 0 ? { entities: [], memories: [], assertions: [] } : {
      entities: [{ key: "user", name: "Example user", type: "person", aliases: [], existing: null, spans: [span] }],
      memories: [{ key: "summary-style", kind: "preference", text: "The user prefers concise release summaries.", entities: ["user"], spans: [span], evidence: { _tag: "Stated" }, supersedes: [] }],
      assertions: [{ key: "prefers", subject: "user", predicate: "prefers", object: { _tag: "Value", value: "concise release summaries" }, text: "The user prefers concise release summaries.", spans: [span], validFrom: null, validTo: null, supersedes: [], supersession: null }],
    }
    const output = JSON.stringify(extraction)
    return Ref.update(extractions, (all) => [...all, { source, output }]).pipe(Effect.as(new UtilityCompletion({ text: output, usage: zeroUsage })))
  } })
  const host = Context.make(MemoryStore, store).pipe(Context.add(UtilityLlm, utility), Context.add(EmbeddingModel.EmbeddingModel, embedding))
  const snapshots: Array<unknown> = []
  const phase = (fresh: boolean) => Effect.scoped(Effect.gen(function* () {
    const sessionsContext = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "process" } }).pipe(
      Layer.provide(Layer.merge(SessionLogFilesLive(journal), TurnAdmissionOpen)),
    ))
    const sessions = Context.get(sessionsContext, Sessions)
    const agent = yield* Agent.define({
      services: Context.merge(host, sessionsContext),
      plugins: [
        { plugin: memoryWindowPlugin, options: { spillMinChars: 1_500, previewChars: 160, ledgerTurnChars: 100 } },
        { plugin: memoryPlugin, options: config },
        { plugin: memoryCapturePlugin, options: { namespace: scope.namespace } },
        { plugin: localSystemPlugin, options: {} },
        { plugin: workspaceToolsPlugin, options: { tools: ["read", "edit"], always: ["read", "edit"], environmentSection: false } },
        { plugin: toolDiscoveryPlugin, options: { grants: ["fs.write"], loadSkill: false } },
        stepLoopPlugin,
      ],
      turnServices: [LanguageModel.LanguageModel], workspace,
      system: "Maintain the example deployment files. Follow the user's requests.",
      budgetTokens: 4_000, limits: { streaming: false, maxSteps: 5 },
    })
    const memory = yield* Ref.make<Option.Option<Context.Service.Shape<typeof LongTermMemory>>>(Option.none())
    const run = (number: number, address: typeof first, text: string, decide: Decision, budget = 4_000) => Effect.gen(function* () {
      const before = yield* sessions.read(address)
      const requests = yield* Ref.make<ReadonlyArray<Request>>([])
      const model = yield* LanguageModel.make({
        generateText: (request) => Effect.gen(function* () {
          const captured = {
            tools: request.tools.map((tool) => tool.name),
            definitions: request.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: toolParametersSchema(tool) })),
            toolChoice: request.toolChoice, responseFormat: request.responseFormat.type,
            prompt: yield* Schema.encodeEffect(Prompt.Prompt)(request.prompt).pipe(Effect.orDie),
          }
          const step = (yield* Ref.get(requests)).length
          yield* Ref.update(requests, (all) => [...all, captured])
          return [...decide(step, JSON.stringify(captured.prompt))]
        }),
        streamText: () => Stream.die("This walkthrough uses non-streamed scripted responses"),
      })
      const result = yield* agent.turn({ turn: { session: address, runId: RunId.make(`turn-${number}`), userMessage: new UserMessage({ text }) }, services: Context.make(LanguageModel.LanguageModel, model) }, (turn) => Effect.gen(function* () {
        const nativeMemory = yield* Effect.serviceOption(LongTermMemory)
        if (Option.isNone(nativeMemory)) return yield* Effect.die("The native memory plugin is missing")
        yield* Ref.set(memory, nativeMemory)
        yield* turn.tools.select(turn.userMessage)
        const done = yield* turn.run({ budgetTokens: budget })
        return { outcome: done.outcome, reply: Option.some(done.text) }
      }))
      const stored = yield* sessions.read(address)
      const entries = yield* entriesOfEvents(stored)
      const snapshot = yield* store.snapshot(scope)
      const queued = yield* store.pending({ engine, namespace: scope.namespace, now: yield* Clock.currentTimeMillis, limit: 50 })
      snapshots.push({ number, session: address.id === second.id ? "B (new conversation)" : fresh ? "A (reopened journal)" : "A", user: text, reply: Option.getOrElse(result.reply, () => ""),
        deploymentFile: yield* io(() => readFile(join(workspace, "deployment.md"), "utf8")),
        requests: yield* Ref.get(requests), journalEvents: stored.length,
        addedEvents: stored.slice(before.length).map((event) => ({ seq: event.seq, kind: event.kind })),
        compactions: entries.flatMap((entry) => entry.runId === `turn-${number}` && entry.body._tag === "Compaction" ? [{ turn: entry.turn, action: entry.body.action }] : []),
        context: stored.slice(before.length).filter((event) => event.kind === "context.built").map((event) => event.data),
        pendingMemoryJobs: queued.length, learnedFacts: snapshot.memories.map((fact) => fact.text),
      })
      yield* io(() => writeFile(join(root, `journal-${address.id === second.id ? "B" : "A"}.json`), JSON.stringify(stored, null, 2)))
    })
    if (!fresh) {
      yield* sessions.create(first)
      yield* run(1, first, `${preference} Read deployment.md and tell me its current lane.`, (step) => step === 0 ? call("read-deployment", "read", { path: "deployment.md" }) : stop("The current lane is green. I will keep the summary concise."))
      yield* run(2, first, "Change the deployment lane from green to blue.", (step) => step === 0 ? call("edit-deployment", "edit", { path: "deployment.md", edits: [{ oldText: "lane: green", newText: "lane: blue" }] }) : stop("Changed the deployment lane to blue."))
      yield* run(3, first, "Read build.log. Find its final error.", (step, prompt) => {
        if (step === 0) return call("read-log", "read", { path: "build.log" })
        const locator = /locator \\"([^"\\]+)\\"/.exec(prompt)?.[1]
        if (step === 1 && locator !== undefined) return call("recall-log-tail", "recall_context", { locator, offset: Math.max(0, log.length - 150) })
        return stop("The final error says the queue worker stopped.")
      })
      const api = yield* Ref.get(memory)
      if (Option.isNone(api)) return yield* Effect.die("No native memory service was built")
      const processed = yield* api.value.process(scope, 20)
      const learned = yield* store.snapshot(scope)
      snapshots.push({ checkpoint: "Host processes pending memory jobs", processed, learnedFacts: learned.memories.map((fact) => fact.text), graphAssertions: learned.graph.assertions.map((edge) => edge.text), extractions: yield* Ref.get(extractions) })
    } else {
      yield* run(4, first, "We reopened the journal. Read the current deployment file.", (step) => step === 0 ? call("read-after-reopen", "read", { path: "deployment.md" }) : stop("The file is still blue after reopening the journal."), 2_600)
      yield* sessions.create(second)
      yield* run(5, second, "How should you write my release summaries, and what lane is the file using?", (step) => step === 0 ? call("read-fresh-session", "read", { path: "deployment.md" }) : stop("Concise release summaries. The current file uses the blue lane."))
    }
  }))
  yield* phase(false)
  yield* phase(true)
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))(yield* io(() => readFile(join(import.meta.dir, "../packages/core/package.json"), "utf8")))
  const sourceHash = createHash("sha256").update(yield* io(() => readFile(import.meta.filename, "utf8"))).digest("hex")
  const report = {
    schemaVersion: 1, sdkVersion: manifest.version, sourceHash,
    setup: { initialFile: "lane: green\nstatus: draft\n", logChars: log.length, normalBudget: 4_000, reopenedBudget: 2_600, modelResponses: "scripted", knowledgeStore: "in-memory reference adapter", journalStore: "real directory-backed session log" },
    note: "Scripted model, extraction and embeddings; real runtime/plugins/files/file journal/compaction/native engine. The reference knowledge store is in-memory and retained across agent reopen, not a persistent database.", root, snapshots,
  }
  const serialized = JSON.stringify(report, null, 2).replaceAll(root, "<demo>")
  yield* io(() => writeFile(join(root, "walkthrough.json"), serialized))
  return { root, report, serialized }
})

if (import.meta.main) {
  if (process.argv.slice(2).some((argument) => argument !== "--write-docs")) {
    console.error("Usage: bun run example:memory [--write-docs]")
    process.exit(2)
  }
  const result = await Effect.runPromise(Effect.scoped(runMemoryWalkthrough(join(import.meta.dir, "../.artifacts/memory-walkthrough"))))
  console.log(`Inspect ${result.root}/walkthrough.json and its workspace/ and journal/ directories.`)
  if (process.argv.includes("--write-docs")) {
    const website = join(import.meta.dir, "../packages/website")
    await mkdir(join(website, "public/examples"), { recursive: true })
    await writeFile(join(website, "src/data/memory-walkthrough.json"), result.serialized + "\n")
    await writeFile(join(website, "public/examples/memory-walkthrough.json"), result.serialized + "\n")
    console.log("Updated the recorded documentation playback and its downloadable evidence.")
  }
}
