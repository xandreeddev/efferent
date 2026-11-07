import { describe, expect, test } from "bun:test"
import { EmbeddingModel, LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Stream } from "effect"
import { ConversationId, CurrentKnowledgeHelperCall, KNOWLEDGE_EXTRACTION_VERSION, KnowledgeJobId, KnowledgeSourceId, LongTermMemory, MemoryStore, RunId, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage, UtilityCompletion, UtilityLlm, knowledgeEngineId, makeKnowledgeIndexMemory, zeroUsage } from "@xandreed/core"
import type { KnowledgeHelperCall } from "@xandreed/core"
import { Agent } from "@xandreed/sdk"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { memoryPlugin, MemoryPluginLive } from "./plugin.adapter.js"
import { memoryCapturePlugin, MemoryCaptureLive } from "./memory-capture.adapter.js"
import { MemoryCapture, MemoryCaptureAdmission } from "./ports/memory-capture.port.js"
import { fixtureExtraction } from "./memory.testing.js"
import { memoryCaptureDefaults, memoryDefaults } from "./memory.entity.js"
import { memoryRecallNote } from "./memory-capability.adapter.js"

describe("memory through the real agent", () => {
  test("committed replies are captured, only the engine of their embedding space processes them, and later sessions see recorded recall context", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* makeKnowledgeIndexMemory()
    const embeddings = yield* EmbeddingModel.make({ embedMany: ({ inputs }) => Effect.succeed({ results: inputs.map(() => [1, 0]), usage: { inputTokens: undefined } }) })
    const prompts = yield* Ref.make<ReadonlyArray<string>>([])
    const helperCalls = yield* Ref.make<ReadonlyArray<Option.Option<KnowledgeHelperCall>>>([])
    const helperPrompts = yield* Ref.make<ReadonlyArray<string>>([])
    const utility = UtilityLlm.of({ complete: (prompt) => {
      const text = /<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? ""
      return Ref.update(helperPrompts, (all) => [...all, prompt]).pipe(
        Effect.andThen(Effect.service(CurrentKnowledgeHelperCall)),
        Effect.flatMap((call) => Ref.update(helperCalls, (all) => [...all, call])),
        Effect.as(new UtilityCompletion({ text: JSON.stringify(fixtureExtraction(text)), usage: zeroUsage })),
      )
    } })
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    const runtime = Context.make(MemoryStore, store).pipe(Context.add(UtilityLlm, utility), Context.add(EmbeddingModel.EmbeddingModel, embeddings))
    const model = yield* LanguageModel.make({
      generateText: (request) => Ref.update(prompts, (all) => [...all, JSON.stringify(request.prompt.content)]).pipe(Effect.as([
        { type: "text", text: "I remember your preference." }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 } } },
      ] as never)), streamText: () => Stream.die("streaming unused") as never,
    })
    const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin,
      { plugin: memoryPlugin, options: { worker: false, review: false, embeddingDimensions: 2 } }, memoryCapturePlugin],
      services: runtime, turnServices: [Sessions, LanguageModel.LanguageModel], limits: { streaming: false },
    })
    const first = { owner: "same-owner", id: ConversationId.make("00000000-0000-4000-8000-0000000000d1") }
    const second = { owner: "same-owner", id: ConversationId.make("00000000-0000-4000-8000-0000000000d2") }
    yield* sessions.create(first)
    yield* sessions.create(second)
    const services = Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model))
    yield* agent.turn({ turn: { session: first, runId: RunId.make("first"), userMessage: new UserMessage({ text: "I prefer tea." }) }, services }, (turn) => turn.reply("I will keep that in mind."))
    const engine = knowledgeEngineId(`memory:${KNOWLEDGE_EXTRACTION_VERSION}`, { model: "host", version: "1", dimensions: 2 })
    const pending = yield* store.pending({ engine, namespace: "default", now: 10_000_000_000_000, limit: 10 })
    expect(pending).toHaveLength(1)
    expect(pending[0]?.engine).toBe(engine)
    const raw = yield* store.source(pending[0]!.scope, pending[0]!.source)
    expect(Option.map(raw, (source) => source.text)).toEqual(Option.some("User: I prefer tea.\n\nAssistant final reply: I will keep that in mind."))
    const live = yield* Layer.build(MemoryPluginLive({ worker: false, review: false, embeddingDimensions: 2 }).pipe(Layer.provide(Layer.succeedContext(runtime))))
    const memory = Context.get(live, LongTermMemory)
    const otherSpace = yield* Layer.build(MemoryPluginLive({ worker: false, review: false, queryPlanning: false, rerank: false, embeddingModel: "other-embedder", embeddingDimensions: 2 }).pipe(Layer.provide(Layer.succeedContext(runtime))))
    expect(yield* Context.get(otherSpace, LongTermMemory).process(pending[0]!.scope, 10)).toBe(0)
    expect(Option.map(yield* store.status(pending[0]!.scope, pending[0]!.id), (job) => job.phase._tag)).toEqual(Option.some("Queued"))
    expect(yield* memory.process(pending[0]!.scope, 10)).toBe(1)
    expect(yield* Ref.get(helperCalls)).toEqual([Option.some({
      purpose: "extract", scope: pending[0]!.scope, job: Option.some({ id: pending[0]!.id, attempt: 1 }), maxOutputTokens: Option.none(),
    })])
    expect(pending[0]!.scope.owner).toBe("same-owner")
    const captureContext = yield* Layer.build(MemoryCaptureLive(memoryCaptureDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(Sessions, sessions), Layer.succeed(LongTermMemory, memory)))))
    expect((yield* Context.get(captureContext, MemoryCapture).sync(first)).sources).toBe(0)
    yield* agent.turn({ turn: { session: second, runId: RunId.make("second"), userMessage: new UserMessage({ text: "What drink do I prefer?" }) }, services }, (turn) => Effect.gen(function* () {
      yield* turn.tools.select(turn.userMessage)
      const result = yield* turn.run({})
      return { outcome: result.outcome, reply: Option.some(result.text) }
    }))
    expect((yield* Ref.get(prompts))[0]).toContain("I prefer tea.")
    const journal = yield* sessions.read(second, { kinds: ["memory.section"] })
    expect(journal.some((event) => JSON.stringify(event.data).includes("recalled-memory"))).toBe(true)
    // Default options: the recall above spent no helper call on query planning or reranking; only extraction did.
    expect((yield* Ref.get(helperPrompts)).map((prompt) => prompt.includes("<knowledge-source>"))).toEqual([true])
  }))))

  test("a turn the host's admission refuses is never captured, recalled or read again, while the turns around it are", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* makeKnowledgeIndexMemory()
    const embeddings = yield* EmbeddingModel.make({ embedMany: ({ inputs }) => Effect.succeed({ results: inputs.map(() => [1, 0]), usage: { inputTokens: undefined } }) })
    const utility = UtilityLlm.of({ complete: (prompt) => Effect.succeed(new UtilityCompletion({ text: JSON.stringify(fixtureExtraction(/<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? "")), usage: zeroUsage })) })
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    // The host's screening: a turn the user marks off the record is never kept across conversations.
    const asked = yield* Ref.make<ReadonlyArray<number>>([])
    const runtime = Context.make(MemoryStore, store).pipe(Context.add(UtilityLlm, utility), Context.add(EmbeddingModel.EmbeddingModel, embeddings), Context.add(MemoryCaptureAdmission, {
      admit: (turn) => Ref.update(asked, (all) => [...all, turn.turn]).pipe(Effect.as(turn.text.startsWith("User: Off the record") ? { _tag: "Refuse" as const } : { _tag: "Admit" as const })),
    }))
    const prompts = yield* Ref.make<ReadonlyArray<string>>([])
    const model = yield* LanguageModel.make({
      generateText: (request) => Ref.update(prompts, (all) => [...all, JSON.stringify(request.prompt.content)]).pipe(Effect.as([
        { type: "text", text: "Noted." }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 5 }, outputTokens: { total: 1 } } },
      ] as never)), streamText: () => Stream.die("streaming unused") as never,
    })
    const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin,
      { plugin: memoryPlugin, options: { worker: false, review: false, embeddingDimensions: 2 } }, memoryCapturePlugin],
      services: runtime, turnServices: [Sessions, LanguageModel.LanguageModel], limits: { streaming: false },
    })
    const first = { owner: "screened-owner", id: ConversationId.make("00000000-0000-4000-8000-0000000000f1") }
    const second = { owner: "screened-owner", id: ConversationId.make("00000000-0000-4000-8000-0000000000f2") }
    yield* sessions.create(first)
    yield* sessions.create(second)
    const services = Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model))
    const say = (session: typeof first, runId: string, text: string) => agent.turn({ turn: { session, runId: RunId.make(runId), userMessage: new UserMessage({ text }) }, services }, (turn) => Effect.gen(function* () {
      yield* turn.tools.select(turn.userMessage)
      const result = yield* turn.run({})
      return { outcome: result.outcome, reply: Option.some(result.text) }
    }))
    yield* say(first, "kept-before", "I prefer tea.")
    yield* say(first, "withheld", "Off the record: the spare key is under the blue pot.")
    yield* say(first, "kept-after", "I walk every morning.")
    // Each committed turn was asked about once, by the observer after its commit.
    expect(yield* Ref.get(asked)).toEqual([1, 2, 3])
    const engine = knowledgeEngineId(`memory:${KNOWLEDGE_EXTRACTION_VERSION}`, { model: "host", version: "1", dimensions: 2 })
    const pending = yield* store.pending({ engine, namespace: "default", now: 10_000_000_000_000, limit: 10 })
    const texts = yield* Effect.forEach(pending, (job) => store.source(job.scope, job.source).pipe(Effect.map(Option.map((source) => source.text))), { concurrency: 1 })
    expect(texts.map((text) => Option.getOrElse(text, () => "")).toSorted()).toEqual([
      "User: I prefer tea.\n\nAssistant final reply: Noted.",
      "User: I walk every morning.\n\nAssistant final reply: Noted.",
    ])
    // The checkpoint is past the refused turn: a later sync, even one that admits everything, reads nothing.
    const live = yield* Layer.build(MemoryPluginLive({ worker: false, review: false, embeddingDimensions: 2 }).pipe(Layer.provide(Layer.succeedContext(runtime))))
    const memory = Context.get(live, LongTermMemory)
    const captureContext = yield* Layer.build(MemoryCaptureLive(memoryCaptureDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(Sessions, sessions), Layer.succeed(LongTermMemory, memory)))))
    expect(yield* Context.get(captureContext, MemoryCapture).sync(first)).toMatchObject({ sources: 0, hasMore: false })
    expect(yield* memory.process(pending[0]!.scope, 10)).toBe(2)
    yield* Ref.set(prompts, [])
    yield* say(second, "asking", "Where is the spare key?")
    const recalled = (yield* Ref.get(prompts))[0] ?? ""
    expect(recalled).toContain("I prefer tea.")
    expect(recalled).toContain("I walk every morning.")
    expect(recalled).not.toContain("spare key is under")
    expect(recalled).not.toContain("blue pot")
  }))))

  test("a capture whose extraction failed for good is listed, requeued by the engine of a new embedding version, and published", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* makeKnowledgeIndexMemory()
    const embeddings = yield* EmbeddingModel.make({ embedMany: ({ inputs }) => Effect.succeed({ results: inputs.map(() => [1, 0]), usage: { inputTokens: undefined } }) })
    const answersInvalid = yield* Ref.make(true)
    const utility = UtilityLlm.of({ complete: (prompt) => Ref.get(answersInvalid).pipe(Effect.map((invalid) => {
      const text = /<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? ""
      return new UtilityCompletion({ text: invalid ? "not an extraction" : JSON.stringify(fixtureExtraction(text)), usage: zeroUsage })
    })) })
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    const runtime = Context.make(MemoryStore, store).pipe(Context.add(UtilityLlm, utility), Context.add(EmbeddingModel.EmbeddingModel, embeddings))
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([{ type: "text", text: "Noted." }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 5 }, outputTokens: { total: 1 } } }] as never),
      streamText: () => Stream.die("streaming unused") as never,
    })
    const options = { worker: false, review: false, embeddingDimensions: 2 }
    const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: memoryPlugin, options }, memoryCapturePlugin],
      services: runtime, turnServices: [Sessions, LanguageModel.LanguageModel], limits: { streaming: false },
    })
    const session = { owner: "requeue-owner", id: ConversationId.make("00000000-0000-4000-8000-0000000000e1") }
    yield* sessions.create(session)
    const services = Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model))
    yield* agent.turn({ turn: { session, runId: RunId.make("requeue"), userMessage: new UserMessage({ text: "I prefer tea." }) }, services }, (turn) => turn.reply("I will keep that in mind."))
    const memoryOf = (embeddingVersion: string) => Layer.build(MemoryPluginLive({ ...options, embeddingVersion }).pipe(Layer.provide(Layer.succeedContext(runtime)))).pipe(Effect.map((live) => Context.get(live, LongTermMemory)))
    const before = yield* memoryOf("1")
    const scope = { owner: session.owner, namespace: "default", collection: "memory" }
    expect((yield* Effect.result(before.process(scope, 10)))._tag).toBe("Failure")
    // The host finds the job without having kept its id: every failed job of the namespace whose extraction was invalid.
    const listed = yield* store.failed({ namespace: "default", reasons: ["Invalid"], limit: 10 })
    expect(listed.jobs.map((job) => ({ owner: job.scope.owner, engine: job.engine, attempt: job.attempt, reason: job.phase._tag === "Failed" ? job.phase.reason : job.phase._tag })))
      .toEqual([{ owner: session.owner, engine: knowledgeEngineId(`memory:${KNOWLEDGE_EXTRACTION_VERSION}`, { model: "host", version: "1", dimensions: 2 }), attempt: 1, reason: "Invalid" }])
    yield* Ref.set(answersInvalid, false)
    const after = yield* memoryOf("2")
    const failed = listed.jobs[0]!
    const requeued = yield* after.retry(failed.scope, failed.id)
    expect({ engine: requeued.engine, attempt: requeued.attempt, phase: requeued.phase._tag })
      .toEqual({ engine: knowledgeEngineId(`memory:${KNOWLEDGE_EXTRACTION_VERSION}`, { model: "host", version: "2", dimensions: 2 }), attempt: 0, phase: "Queued" })
    expect(yield* before.process(scope, 10)).toBe(0)
    expect(yield* after.process(scope, 10)).toBe(1)
    expect(Option.map(yield* after.status(scope, failed.id), (job) => job.phase._tag)).toEqual(Option.some("Complete"))
    expect((yield* store.failed({ namespace: "default", limit: 10 })).jobs).toEqual([])
    const recalled = yield* after.recall({ scope, query: "tea", limit: 5, maxChars: 1000, graph: false })
    expect(recalled.sources.map((source) => source.ref)).toEqual([failed.source])
  }))))

  test("with the recall section off, a host's step context carries the recall at the request's tail and the system prompt stays the same across turns", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* makeKnowledgeIndexMemory()
    const embeddings = yield* EmbeddingModel.make({ embedMany: ({ inputs }) => Effect.succeed({ results: inputs.map(() => [1, 0]), usage: { inputTokens: undefined } }) })
    const utility = UtilityLlm.of({ complete: (prompt) => Effect.succeed(new UtilityCompletion({
      text: JSON.stringify(fixtureExtraction(/<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? "")), usage: zeroUsage,
    })) })
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    const runtime = Context.make(MemoryStore, store).pipe(Context.add(UtilityLlm, utility), Context.add(EmbeddingModel.EmbeddingModel, embeddings))
    // The host builds the engine and gives its services (tools, skills, LongTermMemory) to the agent, the section turned off.
    const options = { recallSection: "off" as const, worker: false, review: false, embeddingDimensions: 2 }
    const engine = yield* Layer.build(MemoryPluginLive(options).pipe(Layer.provide(Layer.succeedContext(runtime))))
    const memory = Context.get(engine, LongTermMemory)
    const requests = yield* Ref.make<ReadonlyArray<{ readonly system: string; readonly last: string; readonly tools: ReadonlyArray<string> }>>([])
    const textOf = (content: string | ReadonlyArray<{ readonly type: string }> | undefined) => typeof content === "string"
      ? content : (content ?? []).flatMap((part) => part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("")
    const model = yield* LanguageModel.make({
      generateText: (request) => Ref.update(requests, (all) => [...all, {
        system: request.prompt.content.filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n"),
        last: textOf(request.prompt.content.at(-1)?.content),
        tools: request.tools.map((tool) => tool.name),
      }]).pipe(Effect.as([
        { type: "text", text: "You prefer tea." }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 5 }, outputTokens: { total: 2 } } },
      ] as never)), streamText: () => Stream.die("streaming unused") as never,
    })
    const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, memoryCapturePlugin],
      services: Context.merge(runtime, engine), turnServices: [Sessions, LanguageModel.LanguageModel], limits: { streaming: false }, system: "Answer briefly.",
    })
    const first = { owner: "same-owner", id: ConversationId.make("00000000-0000-4000-8000-0000000000d3") }
    const second = { owner: "same-owner", id: ConversationId.make("00000000-0000-4000-8000-0000000000d4") }
    yield* sessions.create(first)
    yield* sessions.create(second)
    const services = Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model))
    yield* agent.turn({ turn: { session: first, runId: RunId.make("told"), userMessage: new UserMessage({ text: "I prefer tea." }) }, services }, (turn) => turn.reply("I will keep that in mind."))
    const queued = yield* store.pending({ engine: knowledgeEngineId(`memory:${KNOWLEDGE_EXTRACTION_VERSION}`, { model: "host", version: "1", dimensions: 2 }), namespace: "default", now: 10_000_000_000_000, limit: 10 })
    expect(yield* memory.process(queued[0]!.scope, 10)).toBe(1)
    const notes = yield* Ref.make<ReadonlyArray<Option.Option<string>>>([])
    const note = memoryRecallNote({ ...memoryDefaults, ...options })
    const ask = (runId: string, text: string) => agent.turn({ turn: { session: second, runId: RunId.make(runId), userMessage: new UserMessage({ text }) }, services }, (turn) => Effect.gen(function* () {
      // Recalled once for the turn, and the same text closes the request at each of its steps.
      const recalled = yield* Effect.cached(note.pipe(Effect.tap((text) => Ref.update(notes, (all) => [...all, text]))))
      yield* turn.tools.select(turn.userMessage)
      const result = yield* turn.run({ stepContext: "tail", step: () => recalled.pipe(Effect.map((context) => ({ context, toolChoice: Option.none() }))) })
      return { outcome: result.outcome, reply: Option.some(result.text) }
    }))
    yield* ask("asked", "What drink do I prefer?")
    yield* ask("asked-again", "Do I prefer tea?")
    const recalled = (yield* Ref.get(notes)).flatMap((text) => Option.toArray(text))
    expect(recalled).toHaveLength(2)
    expect(recalled.every((text) => text.includes("<recalled-memory>") && text.includes("I prefer tea."))).toBe(true)
    const sent = yield* Ref.get(requests)
    expect(sent.map((request) => request.last)).toEqual(recalled)
    expect(sent.every((request) => request.tools.includes("recall_memory"))).toBe(true)
    // The system prompt carries no recall and is the same for both turns: one fingerprint is recorded, and no turn context.
    expect(sent.map((request) => request.system)).toEqual([sent[0]!.system, sent[0]!.system])
    expect(sent[0]!.system.includes("recalled-memory")).toBe(false)
    expect((yield* sessions.read(second, { kinds: ["memory.system"] })).length).toBe(1)
    expect(yield* sessions.read(second, { kinds: ["memory.section"] })).toEqual([])
  }))))

  test("an undated change publishes dated at its source's time beside an unrelated fact, and a bad record is dropped alone", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* makeKnowledgeIndexMemory()
    const embeddings = yield* EmbeddingModel.make({ embedMany: ({ inputs }) => Effect.succeed({ results: inputs.map(() => [1, 0]), usage: { inputTokens: undefined } }) })
    const extractionPrompts = yield* Ref.make<ReadonlyArray<string>>([])
    const span = (text: string, quote: string) => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote })
    // The helper model: the first turn says where the user lives; the second states a move without a date, an unrelated fact,
    // and a memory about an entity it never defines. It reads the user and the earlier relation from the candidates it is shown.
    const extract = (prompt: string) => {
      const text = /<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? ""
      const candidates: { readonly entities: ReadonlyArray<{ readonly id: string; readonly name: string }>; readonly assertions: ReadonlyArray<{ readonly id: string; readonly predicate: string }> } =
        JSON.parse(/<knowledge-candidates>\n([\s\S]*?)\n<\/knowledge-candidates>/.exec(prompt)?.[1] ?? "{}")
      const lives = (city: string, quote: string, supersedes: ReadonlyArray<string>) => ({
        key: "lives", subject: "user", predicate: "lives_in", object: { _tag: "Entity", key: city.toLowerCase() }, text: `The user lives in ${city}.`, spans: [span(text, quote)],
        validFrom: null, validTo: null, supersedes, supersession: supersedes.length === 0 ? "correction" : "change",
      })
      const fact = (key: string, entities: ReadonlyArray<string>) => ({ key, kind: "fact", text: "The user's sister plays chess.", entities, spans: [span(text, "My sister plays chess.")], evidence: { _tag: "Stated" }, supersedes: [] })
      return text.includes("Bergen") ? {
        entities: [{ key: "user", name: "User", type: "person", aliases: [], existing: null, spans: [span(text, "I live")] }, { key: "bergen", name: "Bergen", type: "city", aliases: [], existing: null, spans: [span(text, "Bergen")] }],
        memories: [], assertions: [lives("Bergen", "I live in Bergen.", [])],
      } : {
        entities: [
          { key: "user", name: "User", type: "person", aliases: [], existing: candidates.entities.find((entity) => entity.name === "User")?.id ?? null, spans: [span(text, "I moved")] },
          { key: "oslo", name: "Oslo", type: "city", aliases: [], existing: null, spans: [span(text, "Oslo")] },
        ],
        memories: [fact("sister", ["user"]), fact("neighbour", ["neighbour"])],
        assertions: [lives("Oslo", "I moved to Oslo.", candidates.assertions.filter((assertion) => assertion.predicate === "lives_in").map((assertion) => assertion.id))],
      }
    }
    const utility = UtilityLlm.of({ complete: (prompt) => Ref.update(extractionPrompts, (all) => [...all, prompt]).pipe(Effect.as(new UtilityCompletion({ text: JSON.stringify(extract(prompt)), usage: zeroUsage }))) })
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    const runtime = Context.make(MemoryStore, store).pipe(Context.add(UtilityLlm, utility), Context.add(EmbeddingModel.EmbeddingModel, embeddings))
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([{ type: "text", text: "Noted." }, { type: "finish", reason: "stop", usage: { inputTokens: { total: 5 }, outputTokens: { total: 1 } } }] as never),
      streamText: () => Stream.die("streaming unused") as never,
    })
    const options = { worker: false, review: false, embeddingDimensions: 2 }
    const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: memoryPlugin, options }, memoryCapturePlugin],
      services: runtime, turnServices: [Sessions, LanguageModel.LanguageModel], limits: { streaming: false },
    })
    const session = { owner: "moving-owner", id: ConversationId.make("00000000-0000-4000-8000-0000000000c1") }
    yield* sessions.create(session)
    const services = Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model))
    const memory = Context.get(yield* Layer.build(MemoryPluginLive(options).pipe(Layer.provide(Layer.succeedContext(runtime)))), LongTermMemory)
    const scope = { owner: session.owner, namespace: "default", collection: "memory" }
    const engine = knowledgeEngineId(`memory:${KNOWLEDGE_EXTRACTION_VERSION}`, { model: "host", version: "1", dimensions: 2 })
    const say = (runId: string, text: string) => agent.turn({ turn: { session, runId: RunId.make(runId), userMessage: new UserMessage({ text }) }, services }, (turn) => turn.reply("Noted.")).pipe(
      Effect.andThen(store.pending({ engine, namespace: "default", now: 10_000_000_000_000, limit: 10 })),
      Effect.tap((jobs) => memory.process(scope, 10).pipe(Effect.map((processed) => expect(processed).toBe(jobs.length)))),
      Effect.map((jobs) => jobs[0]!),
    )
    yield* say("lived", "I live in Bergen.")
    const moved = yield* say("moved", "I moved to Oslo. My sister plays chess.")
    const source = Option.getOrThrow(yield* store.source(scope, moved.source))
    // The helper read the source's time as ISO 8601 and as the epoch milliseconds its dates are given in.
    expect((yield* Ref.get(extractionPrompts))[1]).toContain(`Source occurrence time: ${new Date(source.occurredAt).toISOString()} (epoch milliseconds ${source.occurredAt}).`)
    const status = Option.getOrThrow(yield* memory.status(scope, moved.id))
    expect(status.phase._tag).toBe("Complete")
    expect(Option.map(status.stage, (stage) => stage.notes)).toEqual(Option.some([
      { _tag: "RecordDropped", record: "memory", key: "neighbour", reason: "Invalid", message: "The extraction refers to an undefined entity key" },
    ]))
    const graph = (yield* store.snapshot(scope)).graph
    const current = graph.assertions.find((assertion) => assertion.text === "The user lives in Oslo.")
    const history = graph.assertions.find((assertion) => assertion.text === "The user lives in Bergen." && Option.isSome(assertion.validTo))
    const retired = graph.assertions.find((assertion) => assertion.text === "The user lives in Bergen." && Option.isNone(assertion.validTo))
    expect([current?.validFrom, current?.validFromBasis, history?.validTo, Option.isSome(retired?.knownTo ?? Option.none())]).toEqual([Option.some(source.occurredAt), "observed", Option.some(source.occurredAt), true])
    // Recall now: the fact and the current relation, not the one the move ended.
    const recalled = yield* memory.recall({ scope, query: "Oslo Bergen chess", limit: 5, maxChars: 2000, graph: { perspective: {}, depth: 1 } })
    expect(recalled.candidates.flatMap((candidate) => candidate._tag === "Memory" ? [candidate.memory.text] : [])).toEqual(["The user's sister plays chess."])
    expect(recalled.graph.assertions.map((assertion) => assertion.text)).toEqual(["The user lives in Oslo."])
    // Recall as of just before the move: the history copy, still valid then.
    const before = yield* memory.recall({ scope, query: "Oslo Bergen chess", limit: 5, maxChars: 2000, graph: { perspective: { validAt: source.occurredAt - 1 }, depth: 1 } })
    expect(before.graph.assertions.map((assertion) => assertion.text)).toEqual(["The user lives in Bergen."])
  }))))
})
