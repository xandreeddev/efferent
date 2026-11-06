import { describe, expect, test } from "bun:test"
import { EmbeddingModel, LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Stream } from "effect"
import { ConversationId, CurrentKnowledgeHelperCall, KnowledgeJobId, KnowledgeSourceId, LongTermMemory, MemoryStore, RunId, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage, UtilityCompletion, UtilityLlm, knowledgeEngineId, makeKnowledgeIndexMemory, zeroUsage } from "@xandreed/core"
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
import { memoryCaptureDefaults } from "./memory.entity.js"

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
    const engine = knowledgeEngineId("memory:1", { model: "host", version: "1", dimensions: 2 })
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
    const engine = knowledgeEngineId("memory:1", { model: "host", version: "1", dimensions: 2 })
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
      .toEqual([{ owner: session.owner, engine: knowledgeEngineId("memory:1", { model: "host", version: "1", dimensions: 2 }), attempt: 1, reason: "Invalid" }])
    yield* Ref.set(answersInvalid, false)
    const after = yield* memoryOf("2")
    const failed = listed.jobs[0]!
    const requeued = yield* after.retry(failed.scope, failed.id)
    expect({ engine: requeued.engine, attempt: requeued.attempt, phase: requeued.phase._tag })
      .toEqual({ engine: knowledgeEngineId("memory:1", { model: "host", version: "2", dimensions: 2 }), attempt: 0, phase: "Queued" })
    expect(yield* before.process(scope, 10)).toBe(0)
    expect(yield* after.process(scope, 10)).toBe(1)
    expect(Option.map(yield* after.status(scope, failed.id), (job) => job.phase._tag)).toEqual(Option.some("Complete"))
    expect((yield* store.failed({ namespace: "default", limit: 10 })).jobs).toEqual([])
    const recalled = yield* after.recall({ scope, query: "tea", limit: 5, maxChars: 1000, graph: false })
    expect(recalled.sources.map((source) => source.ref)).toEqual([failed.source])
  }))))
})
