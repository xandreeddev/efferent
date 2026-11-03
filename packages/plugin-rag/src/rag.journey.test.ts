import { describe, expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Stream } from "effect"
import { ConversationId, Knowledge, RunId, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import { Agent } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { ragPlugin } from "./plugin.adapter.js"
import { enqueue, makeRag, scope } from "./rag.testing.js"

const session = { owner: scope.owner, id: ConversationId.make("00000000-0000-4000-8000-0000000000d1") }
const usage = { inputTokens: { total: 10 }, outputTokens: { total: 2 } }

describe("document retrieval through Agent", () => {
  test("search and source reads use the turn owner and present exact cited evidence", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const rag = yield* makeRag()
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
    // The graph's own service is independent of the host service used to ingest.
    expect(Context.get(rag.built, Knowledge)).toBe(rag.knowledge)
  }))))
})
