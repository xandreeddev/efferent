import { describe, expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Stream } from "effect"
import { ConversationId, KnowledgeNarrowing, KnowledgeSourceId, RunId, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { KnowledgeSourceFilter } from "@xandreed/core"
import { Agent } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { ragPlugin } from "./plugin.adapter.js"
import { enqueue, makeRag, scope } from "./rag.testing.js"

const usage = { inputTokens: { total: 10 }, outputTokens: { total: 2 } }
const first = { owner: scope.owner, id: ConversationId.make("00000000-0000-4000-8000-0000000000e1") }
const second = { owner: scope.owner, id: ConversationId.make("00000000-0000-4000-8000-0000000000e2") }
// The host's own record of which sources each conversation may read; one owner holds both.
const sourcesOf: ReadonlyMap<string, KnowledgeSourceFilter> = new Map([
  [first.id, [KnowledgeSourceId.make("first-notes")]],
  [second.id, [KnowledgeSourceId.make("second-notes")]],
])

describe("document retrieval narrowed per turn", () => {
  test("two conversations of one owner each search, read and recall only their own sources", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const rag = yield* makeRag()
    yield* rag.knowledge.ingest(enqueue("first-notes", "The launch window opens at dawn."))
    yield* rag.knowledge.ingest(enqueue("second-notes", "The launch window opens at dusk."))
    expect(yield* rag.knowledge.process(scope, 2)).toBe(2)
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    yield* sessions.create(first)
    yield* sessions.create(second)
    const narrowing = { reach: (run: { readonly session: { readonly owner: string; readonly id: string } }) => Effect.succeed({ owner: run.session.owner, sources: sourcesOf.get(run.session.id) ?? [] }) }
    const agent = yield* Agent.define({
      plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: ragPlugin, options: { worker: false, embeddingDimensions: 2, recall: true } }],
      services: Context.add(rag.services, KnowledgeNarrowing, narrowing),
      turnServices: [LanguageModel.LanguageModel, Sessions], limits: { streaming: false, maxSteps: 4 },
    })
    // Each conversation searches, then tries to read the other conversation's source.
    const converse = (session: typeof first, foreign: string) => Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([])
      const calls = yield* Ref.make(0)
      const model = yield* LanguageModel.make({
        generateText: (request) => Effect.gen(function* () {
          yield* Ref.update(seen, (all) => [...all, JSON.stringify(request.prompt.content)])
          const step = yield* Ref.getAndUpdate(calls, (count) => count + 1)
          if (step === 0) return [{ type: "tool-call", id: "search", name: "search_knowledge", params: { query: "launch window" } }, { type: "finish", reason: "tool-calls", usage }] as const
          if (step === 1) return [{ type: "tool-call", id: "read", name: "read_knowledge", params: { sourceId: foreign, revision: 1 } }, { type: "finish", reason: "tool-calls", usage }] as const
          return [{ type: "text", text: "Done." }, { type: "finish", reason: "stop", usage }] as const
        }), streamText: () => Stream.die("not scripted"),
      })
      yield* agent.turn({ turn: { session, runId: RunId.make(`narrowed-${session.id}`), userMessage: new UserMessage({ text: "When does the launch window open?" }) }, services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model)) },
        (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({})), Effect.map((answer) => ({ outcome: answer.outcome, reply: Option.some(answer.text) }))))
      return yield* Ref.get(seen)
    })
    const firstRequests = yield* converse(first, "second-notes")
    const secondRequests = yield* converse(second, "first-notes")
    // The recalled section and the search result carry only the conversation's own source.
    expect(firstRequests[0]).toContain('Source \\"first-notes\\"')
    expect(firstRequests[1]).toContain("opens at dawn")
    expect(firstRequests[1]).not.toContain("second-notes")
    expect(firstRequests[1]).not.toContain("opens at dusk")
    expect(secondRequests[0]).toContain('Source \\"second-notes\\"')
    expect(secondRequests[1]).toContain("opens at dusk")
    expect(secondRequests[1]).not.toContain("first-notes")
    expect(secondRequests[1]).not.toContain("opens at dawn")
    // A read of the other conversation's source is not found, and shows none of its text.
    expect(firstRequests[2]).toContain("No source revision is available in this collection")
    expect(firstRequests[2]).not.toContain("opens at dusk")
    expect(secondRequests[2]).toContain("No source revision is available in this collection")
    expect(secondRequests[2]).not.toContain("opens at dawn")
    const tools = (journal: ReadonlyArray<{ readonly kind: string; readonly data: unknown }>) => journal.filter((row) => row.kind === "tool.completed").length
    expect(tools(yield* sessions.read(first))).toBe(2)
    expect(tools(yield* sessions.read(second))).toBe(2)
  }))))
})
