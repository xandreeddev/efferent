import { describe, expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Stream } from "effect"
import { ConversationId, KnowledgeNarrowing, KnowledgeSourceId, RunId, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { KnowledgeMetadataFilter, KnowledgeSourceFilter } from "@xandreed/core"
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

  test("two conversations of one owner narrowed by source metadata see only their own sources, however the rest rank", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const rag = yield* makeRag({ searchLimit: 1 })
    // Each conversation reaches the sources its host marked for it; the other project's notes match the question better.
    yield* rag.knowledge.ingest(enqueue("alpha-notes", "The launch window opens at dawn, after the checks.", 1, { project: "alpha", kind: "notes" }))
    yield* rag.knowledge.ingest(enqueue("beta-notes", "The launch window: the launch window opens at dusk.", 1, { project: "beta", kind: "notes" }))
    yield* rag.knowledge.ingest(enqueue("beta-draft", "The launch window opens at noon.", 1, { project: "beta", kind: "draft" }))
    expect(yield* rag.knowledge.process(scope, 3)).toBe(3)
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    yield* sessions.create(first)
    yield* sessions.create(second)
    const metadataOf: ReadonlyMap<string, KnowledgeMetadataFilter> = new Map<string, KnowledgeMetadataFilter>([
      [first.id, { project: "alpha" }],
      [second.id, { project: "beta", kind: ["notes"] }],
    ])
    const narrowing = { reach: (run: { readonly session: { readonly owner: string; readonly id: string } }) => Effect.succeed({ owner: run.session.owner, metadata: metadataOf.get(run.session.id) ?? { project: [] } }) }
    const agent = yield* Agent.define({
      plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: ragPlugin, options: { worker: false, embeddingDimensions: 2, recall: true, searchLimit: 1 } }],
      services: Context.add(rag.services, KnowledgeNarrowing, narrowing),
      turnServices: [LanguageModel.LanguageModel, Sessions], limits: { streaming: false, maxSteps: 4 },
    })
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
      yield* agent.turn({ turn: { session, runId: RunId.make(`metadata-${session.id}`), userMessage: new UserMessage({ text: "When does the launch window open?" }) }, services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model)) },
        (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({})), Effect.map((answer) => ({ outcome: answer.outcome, reply: Option.some(answer.text) }))))
      return yield* Ref.get(seen)
    })
    const alpha = yield* converse(first, "beta-notes")
    const beta = yield* converse(second, "beta-draft")
    // With one result a search, the section and the search each return the conversation's own best match.
    expect(alpha[0]).toContain('Source \\"alpha-notes\\"')
    expect(alpha[1]).toContain("opens at dawn")
    expect(alpha[1]).not.toContain("opens at dusk")
    expect(beta[0]).toContain('Source \\"beta-notes\\"')
    expect(beta[1]).toContain("opens at dusk")
    expect(beta[1]).not.toContain("opens at noon")
    // A read of a source outside the metadata filter is not found: another project's, or the same project's other kind.
    expect(alpha[2]).toContain("No source revision is available in this collection")
    expect(alpha[2]).not.toContain("opens at dusk")
    expect(beta[2]).toContain("No source revision is available in this collection")
    expect(beta[2]).not.toContain("opens at noon")
  }))))
})
