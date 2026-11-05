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
import { MemoryCapture } from "./ports/memory-capture.port.js"
import { fixtureExtraction } from "./memory.testing.js"
import { memoryCaptureDefaults } from "./memory.entity.js"

describe("memory through the real agent", () => {
  test("committed replies are captured, only the engine of their embedding space processes them, and later sessions see recorded recall context", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* makeKnowledgeIndexMemory()
    const embeddings = yield* EmbeddingModel.make({ embedMany: ({ inputs }) => Effect.succeed({ results: inputs.map(() => [1, 0]), usage: { inputTokens: undefined } }) })
    const prompts = yield* Ref.make<ReadonlyArray<string>>([])
    const helperCalls = yield* Ref.make<ReadonlyArray<Option.Option<KnowledgeHelperCall>>>([])
    const utility = UtilityLlm.of({ complete: (prompt) => {
      const text = /<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? ""
      return Effect.service(CurrentKnowledgeHelperCall).pipe(
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
      { plugin: memoryPlugin, options: { worker: false, review: false, queryPlanning: false, rerank: false, embeddingDimensions: 2 } }, memoryCapturePlugin],
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
    const live = yield* Layer.build(MemoryPluginLive({ worker: false, review: false, queryPlanning: false, rerank: false, embeddingDimensions: 2 }).pipe(Layer.provide(Layer.succeedContext(runtime))))
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
  }))))
})
