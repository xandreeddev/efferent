import { describe, expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import {
  ConversationId, Knowledge, KnowledgeRecallResult, onEvent, RunId, SessionLogMemoryLive, Sessions, subscribeAll, TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import { Agent } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { knowledgeEvidenceText, ragDefaults, ragPlugin } from "./index.js"
import { enqueue, makeRag, scope, scriptedUtility } from "./rag.testing.js"

const session = { owner: scope.owner, id: ConversationId.make("00000000-0000-4000-8000-0000000000d1") }
const usage = { inputTokens: { total: 10 }, outputTokens: { total: 2 } }

describe("document retrieval through Agent", () => {
  test("search and source reads use the turn owner and present exact cited evidence", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    // A UtilityLlm is present, yet default options spend no helper call on query planning or reranking.
    const helper = yield* scriptedUtility([])
    const rag = yield* makeRag({}, undefined, undefined, helper.utility)
    yield* rag.knowledge.ingest(enqueue("guide", "The release lane is blue."))
    yield* rag.knowledge.process(scope, 1)
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    yield* sessions.create({ owner: session.owner, id: session.id })
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    const calls = yield* Ref.make(0)
    const model = yield* LanguageModel.make({
      generateText: (request) => Effect.gen(function* () {
        yield* Ref.update(seen, (all) => [...all, JSON.stringify(request.prompt.content)])
        const step = yield* Ref.getAndUpdate(calls, (count) => count + 1)
        if (step === 0) return [{ type: "tool-call", id: "search", name: "search_knowledge", params: { query: "release lane" } }, { type: "finish", reason: "tool-calls", usage }] as const
        if (step === 1) return [{ type: "tool-call", id: "read", name: "read_knowledge", params: { sourceId: "guide", revision: 1 } }, { type: "finish", reason: "tool-calls", usage }] as const
        return [{ type: "text", text: "The guide says blue." }, { type: "finish", reason: "stop", usage }] as const
      }), streamText: () => Stream.die("not scripted"),
    })
    const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: ragPlugin, options: { worker: false, embeddingDimensions: 2, recall: true } }], services: rag.services,
      turnServices: [LanguageModel.LanguageModel, Sessions], limits: { streaming: false, maxSteps: 4 } })
    const result = yield* agent.turn({ turn: { session, runId: RunId.make("rag-search-read"), userMessage: new UserMessage({ text: "Find the release lane." }) }, services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model)) },
      (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({})), Effect.map((answer) => ({ outcome: answer.outcome, reply: Option.some(answer.text) }))))
    expect(result.reply).toEqual(Option.some("The guide says blue."))
    const requests = yield* Ref.get(seen)
    expect(requests[0]).toContain("knowledge-evidence")
    expect(requests[1]).toContain("revision 1, characters 0-25")
    expect(requests[2]).toContain("knowledge-source")
    const journal = yield* sessions.read(session)
    expect(journal.filter((row) => row.kind === "tool.completed").map((row) => row.data.tool)).toEqual(["search_knowledge", "read_knowledge"])
    expect(journal.some((row) => row.kind === "memory.section" && JSON.stringify(row.data).includes("knowledge.evidence"))).toBe(true)
    expect(yield* Ref.get(helper.prompts)).toEqual([])
    // The graph's own service is independent of the host service used to ingest.
    expect(Context.get(rag.built, Knowledge)).toBe(rag.knowledge)
  }))))

  test("a host reads the cited sources' metadata from a search and renders its evidence as the tool does", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const rag = yield* makeRag()
    const input = enqueue("handbook", "Deploys go out on the blue lane.")
    const metadata = { title: "Release handbook", section: "Deploys", tags: ["release"] }
    yield* rag.knowledge.ingest({ ...input, source: { ...input.source, occurredAt: 5, metadata } })
    yield* rag.knowledge.process(scope, 1)
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    yield* sessions.create({ owner: session.owner, id: session.id })
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    const searched = yield* Ref.make<ReadonlyArray<KnowledgeRecallResult>>([])
    const calls = yield* Ref.make(0)
    const model = yield* LanguageModel.make({
      generateText: (request) => Effect.gen(function* () {
        yield* Ref.update(seen, (all) => [...all, JSON.stringify(request.prompt.content)])
        if ((yield* Ref.getAndUpdate(calls, (count) => count + 1)) === 0) return [{ type: "tool-call", id: "search", name: "search_knowledge", params: { query: "blue lane" } }, { type: "finish", reason: "tool-calls", usage }] as const
        return [{ type: "text", text: "Blue." }, { type: "finish", reason: "stop", usage }] as const
      }), streamText: () => Stream.die("not scripted"),
    })
    const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: ragPlugin, options: { worker: false, embeddingDimensions: 2 } }], services: rag.services,
      turnServices: [LanguageModel.LanguageModel, Sessions], limits: { streaming: false, maxSteps: 3 } })
    const isResult = Schema.is(KnowledgeRecallResult)
    yield* agent.turn({ turn: { session, runId: RunId.make("rag-search-sources"), userMessage: new UserMessage({ text: "Which lane do deploys use?" }) }, services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model)) },
      (turn) => subscribeAll(turn.events, [
        onEvent("tool.completed", ({ tool, result }) => tool === "search_knowledge" && isResult(result) ? Ref.update(searched, (all) => [...all, result]) : Effect.void),
      ]).pipe(Effect.andThen(turn.tools.select(turn.userMessage)), Effect.andThen(turn.run({})), Effect.map((answer) => ({ outcome: answer.outcome, reply: Option.some(answer.text) }))))
    const [result] = yield* Ref.get(searched)
    expect(result?.sources).toEqual([{ ref: input.source.ref, occurredAt: 5, recordedAt: 20, metadata }])
    // The exported formatter is the tool's own view: a host's tool shows the model the same text.
    const requests = yield* Ref.get(seen)
    expect(requests[1]).toContain(JSON.stringify(knowledgeEvidenceText(result!, ragDefaults.evidenceChars)).slice(1, -1))
  }))))
})
