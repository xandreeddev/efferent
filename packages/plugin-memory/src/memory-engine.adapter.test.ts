import { describe, expect, test } from "bun:test"
import { EmbeddingModel } from "effect/ai"
import { TestClock } from "effect/testing"
import { Clock, Context, Effect, Layer, Option, Order, Ref } from "effect"
import { KnowledgeJobId, KnowledgeMemoryId, KnowledgeSourceId, LongTermMemory, MemoryStore, citedKnowledgeSources, knowledgeExtractionWindows } from "@xandreed/core"
import type { KnowledgeCandidate, KnowledgeHelperCall, KnowledgeMemory, KnowledgeMetadataFilter, KnowledgeRecall, KnowledgeRecallResult, KnowledgeSearch } from "@xandreed/core"
import { MemoryLive } from "./memory-engine.adapter.js"
import { memoryDefaults } from "./memory.entity.js"
import type { MemoryConfig } from "./memory.entity.js"
import { fixtureEnqueue, fixtureExtraction, fixtureScope, makeMemoryFixture } from "./memory.testing.js"

describe("native memory engine", () => {
  test("processing takes a new memory about the same entity, close enough to an active one, as a restatement of it; restatementSimilarity false keeps both", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    // The extraction reuses the person the candidates already know, so both sources' memories are about one entity.
    const restating = (prompt: string) => {
      const text = /<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? ""
      const person = /"id":"([^"]*:entity:person)"/.exec(/<knowledge-candidates>\n([\s\S]*?)\n<\/knowledge-candidates>/.exec(prompt)?.[1] ?? "")?.[1] ?? null
      const extracted = fixtureExtraction(text)
      return JSON.stringify({ ...extracted, entities: extracted.entities.map((entity) => ({ ...entity, existing: person })), assertions: [] })
    }
    const run = (options: Partial<MemoryConfig>) => Effect.gen(function* () {
      const fixture = yield* makeMemoryFixture(restating, options)
      yield* fixture.memory.capture(fixtureEnqueue("session-a", "I prefer tea."))
      yield* fixture.memory.process(fixtureScope, 10)
      yield* fixture.memory.capture(fixtureEnqueue("session-b", "I really prefer tea."))
      yield* fixture.memory.process(fixtureScope, 10)
      const memories = (yield* fixture.store.snapshot(fixtureScope)).memories
      const job = yield* fixture.store.status(fixtureScope, KnowledgeJobId.make("job:session-b"))
      return { memories, corroborations: Option.flatMap(job, (value) => value.stage).pipe(Option.map((stage) => stage.corroborations ?? [])) }
    })
    const merged = yield* run({})
    expect(merged.memories.map((memory) => [memory.text, memory.mentions?.map((ref) => String(ref.id))])).toEqual([["I prefer tea.", ["session-a", "session-b"]]])
    expect(Option.map(merged.corroborations, (all) => all.map((corroboration) => [corroboration.memory, corroboration.provenance.map((span) => span.quote)]))).toEqual(Option.some([[merged.memories[0]!.id, ["I really prefer tea."]]]))
    const separate = yield* run({ restatementSimilarity: false })
    expect(separate.memories.map((memory) => memory.text)).toEqual(["I prefer tea.", "I really prefer tea."])
    expect(separate.corroborations).toEqual(Option.some([]))
  }))))

  test("a reviewer that returns the proposal from its prompt unchanged publishes the job, with an absent and a known identity alike", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const frame = (tag: string, prompt: string) => new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(prompt)?.[1] ?? ""
    // Extraction names the person the candidates already know, or none; review copies the proposal back verbatim.
    const reply = (prompt: string, call: Option.Option<KnowledgeHelperCall>) => {
      if (Option.exists(call, (value) => value.purpose === "review")) return frame("knowledge-proposal", prompt)
      const person = /"id":"([^"]*:entity:person)"/.exec(frame("knowledge-candidates", prompt))?.[1] ?? null
      const extracted = fixtureExtraction(frame("knowledge-source", prompt))
      return JSON.stringify({ ...extracted, entities: extracted.entities.map((entity) => ({ ...entity, existing: person })) })
    }
    const fixture = yield* makeMemoryFixture(reply, { review: true })
    yield* fixture.memory.capture(fixtureEnqueue("session-a", "I prefer tea."))
    expect(yield* fixture.memory.process(fixtureScope, 10)).toBe(1)
    yield* fixture.memory.capture(fixtureEnqueue("session-b", "I prefer coffee now."))
    expect(yield* fixture.memory.process(fixtureScope, 10)).toBe(1)
    const phases = yield* Effect.forEach(["session-a", "session-b"], (id) => fixture.store.status(fixtureScope, KnowledgeJobId.make(`job:${id}`)).pipe(Effect.map(Option.map((job) => job.phase._tag))), { concurrency: 1 })
    expect(phases).toEqual([Option.some("Complete"), Option.some("Complete")])
    const snapshot = yield* fixture.store.snapshot(fixtureScope)
    expect(snapshot.memories.map((memory) => memory.text)).toEqual(["I prefer tea.", "I prefer coffee now."])
    expect(snapshot.graph.entities.map((entity) => entity.id)).toHaveLength(1)
    expect((yield* Ref.get(fixture.helperCalls)).map(Option.map((call) => call.purpose))).toEqual((["extract", "review", "extract", "review"] as const).map((purpose) => Option.some(purpose)))
    const proposals = (yield* Ref.get(fixture.calls)).filter((_, index) => index % 2 === 1).map((prompt) => frame("knowledge-proposal", prompt))
    expect(proposals.some((proposal) => proposal.includes("\"_id\":\"Option\""))).toBe(false)
    expect(proposals.map((proposal) => /"existing":(null|"[^"]*")/.exec(proposal)?.[1])).toEqual(["null", `"${snapshot.graph.entities[0]!.id}"`])
  }))))

  test("an extraction that gives no supersession for records that supersede nothing publishes them, null or absent alike", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const text = "I prefer tea."
    const extracted = fixtureExtraction(text)
    // The memory's supersession is null and the relation has none, as extraction models reply when a record replaces nothing.
    const reply = JSON.stringify({
      ...extracted,
      memories: extracted.memories.map((memory) => ({ ...memory, supersession: null })),
      assertions: extracted.assertions.map(({ supersession: _, ...assertion }) => assertion),
    })
    const fixture = yield* makeMemoryFixture([reply])
    yield* fixture.memory.capture(fixtureEnqueue("session-a", text))
    expect(yield* fixture.memory.process(fixtureScope, 10)).toBe(1)
    const job = yield* fixture.store.status(fixtureScope, KnowledgeJobId.make("job:session-a"))
    expect(Option.map(job, (value) => [value.phase._tag, Option.map(value.stage, (stage) => stage.notes ?? [])])).toEqual(Option.some(["Complete", Option.some([])]))
    const snapshot = yield* fixture.store.snapshot(fixtureScope)
    expect([snapshot.memories.map((memory) => [memory.text, "replaces" in memory]), snapshot.graph.assertions.map((assertion) => [assertion.predicate, "replaces" in assertion])]).toEqual([[[text, false]], [["prefers", false]]])
  }))))

  test("capture is durable before processing, then facts and graph evidence are recalled across sessions", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const text = "I prefer tea."
    const fixture = yield* makeMemoryFixture([JSON.stringify(fixtureExtraction(text))])
    const job = yield* fixture.memory.capture(fixtureEnqueue("session-a", text))
    expect(job.phase._tag).toBe("Queued")
    expect((yield* fixture.store.snapshot(fixtureScope)).memories).toEqual([])
    expect(yield* fixture.memory.process(fixtureScope, 10)).toBe(1)
    const result = yield* fixture.memory.recall({ scope: fixtureScope, query: "preferred drink", limit: 8, maxChars: 8_000 })
    expect(result.candidates.map((candidate) => candidate._tag)).toEqual(["Memory"])
    expect(result.graph.assertions.map((assertion) => assertion.predicate)).toEqual(["prefers"])
    expect((yield* fixture.memory.profile(fixtureScope)).map((memory) => memory.text)).toEqual([text])
    const other = yield* fixture.memory.recall({ scope: { ...fixtureScope, owner: "other-owner" }, query: "preferred drink", limit: 8, maxChars: 8_000 })
    expect(other).toEqual({ candidates: [], graph: { entities: [], assertions: [], truncated: false }, history: [], sources: [] })
  }))))

  test("the profile is ordered by episodes, then by when last said, then by id, with each memory's support, whatever the store's order; supportWeight 0 reads nothing and orders by id", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    // Each source states the same preference about a person of its own, so none restates another: one memory per source.
    const said = [["session-b", 30], ["session-a", 10], ["session-d", 20], ["session-c", 20]] as const
    const profileOf = (options: Partial<MemoryConfig>) => Effect.gen(function* () {
      const fixture = yield* makeMemoryFixture([JSON.stringify(fixtureExtraction("I prefer tea."))], options)
      const reads = yield* Ref.make(0)
      const counted = { ...fixture.store, sourceInfo: (scope: typeof fixtureScope, refs: Parameters<typeof fixture.store.sourceInfo>[1]) => Ref.update(reads, (count) => count + 1).pipe(Effect.andThen(fixture.store.sourceInfo(scope, refs))) }
      const memory = Context.get(yield* Layer.build(MemoryLive(fixture.config).pipe(Layer.provide(Layer.succeedContext(Context.add(fixture.services, MemoryStore, counted))))), LongTermMemory)
      yield* Effect.forEach(said, ([session, occurredAt]) => {
        const input = fixtureEnqueue(session, "I prefer tea.")
        return memory.capture({ ...input, source: { ...input.source, occurredAt } })
      }, { concurrency: 1 })
      expect(yield* memory.process(fixtureScope, 10)).toBe(4)
      yield* Ref.set(reads, 0)
      const profile = yield* memory.profile(fixtureScope)
      return { order: profile.map((record) => [record.id.split(":")[0], record.support?.lastSeen ?? null]), reads: yield* Ref.get(reads) }
    })
    // The in-memory store keeps insertion order (b, a, d, c); the profile is the latest said first, the tie by id, in one read.
    expect(yield* profileOf({})).toEqual({ order: [["session-b", 30], ["session-c", 20], ["session-d", 20], ["session-a", 10]], reads: 1 })
    expect(yield* profileOf({ supportWeight: 0 })).toEqual({ order: [["session-a", null], ["session-b", null], ["session-c", null], ["session-d", null]], reads: 0 })
  }))))

  test("a metadata filter recalls memories and graph evidence only from source revisions whose metadata matches", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const tea = "I prefer tea."
    const coffee = "I prefer coffee."
    const fixture = yield* makeMemoryFixture((prompt) => JSON.stringify(fixtureExtraction(prompt.includes(coffee) ? coffee : tea)))
    yield* fixture.memory.capture(fixtureEnqueue("session-a", tea))
    yield* fixture.memory.capture(fixtureEnqueue("session-b", coffee))
    expect(yield* fixture.memory.process(fixtureScope, 10)).toBe(2)
    const cited = (result: KnowledgeRecallResult) => [...new Set(citedKnowledgeSources(result).map((ref) => String(ref.id)))].toSorted(Order.String)
    const recall = (metadata: KnowledgeMetadataFilter) => fixture.memory.recall({ scope: fixtureScope, query: "prefer", limit: 8, maxChars: 8_000, metadata })
    const onlyA = yield* recall({ session: "session-a" })
    expect([cited(onlyA), onlyA.candidates.map((candidate) => candidate._tag === "Memory" ? candidate.memory.text : ""), onlyA.graph.assertions.map((edge) => edge.text)]).toEqual([["session-a"], [tea], [tea]])
    expect(onlyA.sources.map((source) => source.metadata)).toEqual([{ kind: "conversation", session: "session-a" }])
    expect(cited(yield* recall({ kind: "conversation" }))).toEqual(["session-a", "session-b"])
    expect(cited(yield* recall({ kind: "conversation", session: ["session-b", "session-c"] }))).toEqual(["session-b"])
    const none = yield* recall({ session: "session-c" })
    expect([none.candidates, none.graph.assertions, none.graph.entities, none.sources]).toEqual([[], [], [], []])
    // Beside a source list, both must hold.
    const both = yield* fixture.memory.recall({ scope: fixtureScope, query: "prefer", limit: 8, maxChars: 8_000, metadata: { session: "session-a" }, sources: [KnowledgeSourceId.make("session-b")] })
    expect([both.candidates, both.graph.assertions, both.graph.entities]).toEqual([[], [], []])
  }))))

  test("duplicate capture retains one job and runs extraction once", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const text = "I prefer tea."
    const fixture = yield* makeMemoryFixture([JSON.stringify(fixtureExtraction(text))])
    yield* fixture.memory.capture(fixtureEnqueue("same", text))
    yield* fixture.memory.capture(fixtureEnqueue("same", text))
    yield* fixture.memory.process(fixtureScope, 10)
    yield* fixture.memory.capture(fixtureEnqueue("same", text))
    expect(yield* fixture.memory.process(fixtureScope, 10)).toBe(0)
    expect((yield* Ref.get(fixture.calls)).length).toBe(1)
    expect((yield* fixture.store.snapshot(fixtureScope)).memories).toHaveLength(1)
  }))))

  test("invalid model output fails the job with reason Invalid, unretried, and publishes no facts", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeMemoryFixture(["This is not JSON"], { maxAttempts: 3 })
    const job = yield* fixture.memory.capture(fixtureEnqueue("invalid", "I prefer tea."))
    const result = yield* fixture.memory.process(fixtureScope, 1).pipe(Effect.result)
    expect(result._tag).toBe("Failure")
    expect(Option.map(yield* fixture.memory.status(fixtureScope, job.id), (status) => [status.phase, status.attempt])).toEqual(Option.some([
      { _tag: "Failed", reason: "Invalid", message: "The extraction model returned an invalid knowledge object", step: "Required" }, 1,
    ]))
    expect(yield* Ref.get(fixture.calls)).toHaveLength(1)
    expect((yield* fixture.memory.retry(fixtureScope, job.id)).phase._tag).toBe("Queued")
    expect((yield* fixture.store.snapshot(fixtureScope)).memories).toEqual([])
    expect(yield* fixture.memory.source(fixtureScope, job.source)).not.toEqual(Option.none())
  }))))

  test("explicit corrections supersede memories while retaining their historical evidence", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const previous = "I prefer tea."
    const next = "I now prefer coffee."
    const original = fixtureExtraction(previous)
    const corrected = { ...fixtureExtraction(next),
      entities: [{ ...fixtureExtraction(next).entities[0]!, existing: "old:1:entity:person" }],
      memories: [{ ...fixtureExtraction(next).memories[0]!, supersedes: ["old:1:memory:preference"] }],
      assertions: [{ ...fixtureExtraction(next).assertions[0]!, object: { _tag: "Value", value: "coffee" }, supersedes: ["old:1:assertion:prefers"] }],
    }
    const fixture = yield* makeMemoryFixture([JSON.stringify(original), JSON.stringify(corrected)])
    yield* fixture.memory.capture(fixtureEnqueue("old", previous))
    yield* fixture.memory.process(fixtureScope, 1)
    yield* fixture.memory.capture(fixtureEnqueue("new", next))
    yield* fixture.memory.process(fixtureScope, 1)
    const records = (yield* fixture.store.snapshot(fixtureScope)).memories
    expect(records).toHaveLength(2)
    expect(records.filter((memory) => Option.isNone(memory.knownTo)).map((memory) => memory.text)).toEqual([next])
    yield* fixture.memory.forget(fixtureScope, KnowledgeSourceId.make("old"))
    expect((yield* fixture.memory.recall({ scope: fixtureScope, query: "tea", limit: 8, maxChars: 8_000 })).candidates).toEqual([])
    expect((yield* fixture.memory.capture(fixtureEnqueue("old", previous)).pipe(Effect.result))._tag).toBe("Failure")
  }))))

  test("recall follows a current memory's links to earlier states: changes by default, corrections only with all, none with none", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const said = { a: "I drink coffee.", b: "I drink tea now.", c: "I live in Oslo.", d: "Sorry, I live in Bergen." } as const
    const memoryOf = (key: string, text: string, supersedes: ReadonlyArray<string>, supersession: string) => ({
      key, kind: "preference", text, entities: [], spans: [{ start: 0, end: text.length, quote: text }], evidence: { _tag: "Stated" }, supersedes, supersession,
    })
    const extraction = (prompt: string) => {
      const text = /<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? ""
      const memories = text === said.b ? [memoryOf("drink", text, ["a:1:memory:drink"], "change")]
        : text === said.d ? [memoryOf("place", text, ["c:1:memory:place"], "correction")]
          : [memoryOf(text === said.a ? "drink" : "place", text, [], "change")]
      return JSON.stringify({ entities: [], memories, assertions: [] })
    }
    // The fixture embeds every one of these preferences alike: collapsing would fold them into one.
    const fixture = yield* makeMemoryFixture(extraction, { recallCollapseSimilarity: false })
    yield* Effect.forEach(Object.entries(said), ([id, text]) => fixture.memory.capture(fixtureEnqueue(id, text)).pipe(Effect.andThen(fixture.memory.process(fixtureScope, 1))), { concurrency: 1 })
    const recall = (more: Partial<KnowledgeRecall> = {}) => fixture.memory.recall({ scope: fixtureScope, query: "What do I drink and where do I live?", limit: 8, maxChars: 8_000, ...more })
    const earlier = (result: KnowledgeRecallResult) => result.history.map((state) => [state.successor, state.record.text, state.supersession, state.until])
    const current = yield* recall()
    expect(current.candidates.flatMap((candidate) => candidate._tag === "Memory" ? [candidate.memory.text] : []).toSorted(Order.String)).toEqual([said.d, said.b].toSorted(Order.String))
    expect(earlier(current)).toEqual([["memory:b:1:memory:drink", said.a, "change", 1]])
    // The earlier state's revision is among the sources, so a renderer can date and cite it.
    expect(current.sources.map((info): string => info.ref.id).toSorted(Order.String)).toEqual(["a", "b", "d"])
    const all = yield* recall({ history: "all" })
    expect(earlier(all).toSorted((left, right) => Order.String(String(left[1]), String(right[1])))).toEqual([["memory:b:1:memory:drink", said.a, "change", 1], ["memory:d:1:memory:place", said.c, "correction", 1]])
    expect(earlier(yield* recall({ history: "none" }))).toEqual([])
    // An earlier state outside the reach is skipped, whether by its source or its metadata.
    expect(earlier(yield* recall({ sources: [KnowledgeSourceId.make("b"), KnowledgeSourceId.make("d")] }))).toEqual([])
    expect(earlier(yield* recall({ sources: [KnowledgeSourceId.make("a"), KnowledgeSourceId.make("b")] }))).toEqual([["memory:b:1:memory:drink", said.a, "change", 1]])
    expect(earlier(yield* recall({ metadata: { session: "b" } }))).toEqual([])
    expect(earlier(yield* recall({ metadata: { session: ["a", "b"] } }))).toEqual([["memory:b:1:memory:drink", said.a, "change", 1]])
    // Forgetting the earlier source leaves the current memory's link dangling: it is skipped.
    yield* fixture.memory.forget(fixtureScope, KnowledgeSourceId.make("a"))
    const forgotten = yield* recall()
    expect([forgotten.candidates.some((candidate) => candidate._tag === "Memory" && candidate.memory.text === said.b), earlier(forgotten)]).toEqual([true, []])
  }))))

  test("world changes retain a revised historical graph interval at current knowledge time", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const oldText = "I prefer tea."
    const newText = "I changed to coffee at time 50."
    const original = fixtureExtraction(oldText)
    const changed = { ...fixtureExtraction(newText),
      entities: [{ ...fixtureExtraction(newText).entities[0]!, existing: "earlier:1:entity:person" }],
      assertions: [{ ...fixtureExtraction(newText).assertions[0]!, object: { _tag: "Value", value: "coffee" }, validFrom: 50, supersedes: ["earlier:1:assertion:prefers"], supersession: "change" }],
    }
    const fixture = yield* makeMemoryFixture([JSON.stringify(original), JSON.stringify(changed)])
    yield* fixture.memory.capture(fixtureEnqueue("earlier", oldText))
    yield* fixture.memory.process(fixtureScope, 1)
    yield* fixture.memory.capture(fixtureEnqueue("later", newText))
    yield* fixture.memory.process(fixtureScope, 1)
    const now = yield* Clock.currentTimeMillis
    const past = yield* fixture.memory.recall({ scope: fixtureScope, query: "User", limit: 8, maxChars: 8_000, graph: { perspective: { validAt: 20, knownAt: now }, depth: 2 } })
    expect(past.graph.assertions.map((assertion) => assertion.object)).toEqual([{ _tag: "Value", value: "tea" }])
  }))))

  test("query planning and reranking are opt-in: by default recall makes no helper call", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    expect([memoryDefaults.queryPlanning, memoryDefaults.rerank]).toEqual([false, false])
    const text = "I prefer tea."
    const helperCalls = (options: Partial<MemoryConfig>) => Effect.gen(function* () {
      const fixture = yield* makeMemoryFixture([
        JSON.stringify(fixtureExtraction(text)),
        ...(options.queryPlanning === true ? [JSON.stringify({ queries: ["tea"], entities: [], validAt: null, knownAt: null })] : []),
        ...(options.rerank === true ? [JSON.stringify({ order: [] })] : []),
      ], options)
      yield* fixture.memory.capture(fixtureEnqueue("helpers", text))
      yield* fixture.memory.process(fixtureScope, 1)
      const processed = (yield* Ref.get(fixture.calls)).length
      yield* fixture.memory.recall({ scope: fixtureScope, query: "tea", limit: 8, maxChars: 8_000 })
      return (yield* Ref.get(fixture.calls)).slice(processed).map((prompt) => prompt.startsWith("Plan evidence retrieval") ? "plan" : prompt.startsWith("Rank candidate evidence") ? "rerank" : "other")
    })
    expect(yield* helperCalls({})).toEqual([])
    expect(yield* helperCalls({ queryPlanning: true })).toEqual(["plan"])
    expect(yield* helperCalls({ rerank: true })).toEqual(["rerank"])
    expect(yield* helperCalls({ queryPlanning: true, rerank: true })).toEqual(["plan", "rerank"])
  }))))

  test("with query planning, each query's lists are ranked on their own and a memory several queries find sums their votes", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const texts = { first: "I prefer tea.", second: "I prefer juice.", third: "I prefer water.", later: "I prefer milk." }
    const plan = JSON.stringify({ queries: ["milk"], entities: [], validAt: null, knownAt: null })
    const fixture = yield* makeMemoryFixture((prompt) => prompt.startsWith("Plan evidence retrieval") ? plan
      : JSON.stringify(fixtureExtraction(/<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? "")))
    yield* Effect.forEach(Object.entries(texts), ([id, text]) => fixture.memory.capture(fixtureEnqueue(id, text)), { concurrency: 1 })
    expect(yield* fixture.memory.process(fixtureScope, 10)).toBe(4)
    const stored = new Map((yield* fixture.store.snapshot(fixtureScope)).memories.map((memory) => [memory.text, memory] as const))
    const listed = (...named: ReadonlyArray<keyof typeof texts>): ReadonlyArray<KnowledgeCandidate> => named.map((name) => ({ _tag: "Memory", memory: stored.get(texts[name])!, score: 1 }))
    // The asked question finds three memories in both arms; the planned query finds `later` first, then `third`.
    const lists = (query: KnowledgeSearch) => query.query === "drink"
      ? { lexical: listed("first", "second", "third"), semantic: listed("first", "second", "third") }
      : { lexical: listed("later", "third"), semantic: listed("later") }
    const searched = yield* Ref.make<ReadonlyArray<string>>([])
    const services = Context.add(fixture.services, MemoryStore, { ...fixture.store, search: (query) => Ref.update(searched, (all) => [...all, query.query]).pipe(Effect.as(lists(query))) })
    // The fixture embeds every one of these preferences alike: collapsing would fold them into one.
    const context = yield* Layer.build(MemoryLive({ ...fixture.config, queryPlanning: true, recallCollapseSimilarity: false }).pipe(Layer.provide(Layer.succeedContext(services))))
    const result = yield* Context.get(context, LongTermMemory).recall({ scope: fixtureScope, query: "drink", limit: 8, maxChars: 8_000, graph: false })
    expect(yield* Ref.get(searched)).toEqual(["drink", "milk"])
    // third: 2/63 + 1/62; first and later: 2/61 each, tied by key; second: 2/62. Concatenated lists ranked later last.
    expect(result.candidates.map((candidate) => [candidate._tag === "Memory" ? candidate.memory.text : "", candidate.score])).toEqual([
      [texts.third, 1 / 63 + 1 / 63 + 1 / 62], [texts.first, 2 / 61], [texts.later, 2 / 61], [texts.second, 2 / 62],
    ])
  }))))

  test("recall weighs a memory by the distinct episodes that state it, gives it its support, and a weight of 0 reads nothing", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeMemoryFixture(["{}"])
    // Four captured turns: three state the repeated preference, one the single one; each turn is its own episode.
    const said = ["monday", "tuesday", "friday", "single"] as const
    yield* Effect.forEach(said, (name, index) => {
      const enqueue = fixtureEnqueue(name, `Turn ${name}.`)
      return fixture.memory.capture({ ...enqueue, source: { ...enqueue.source, occurredAt: Date.UTC(2026, 5, index + 1), metadata: { kind: "conversation", episode: `turn:${name}` } } })
    }, { concurrency: 1 })
    const ref = (name: string) => ({ id: KnowledgeSourceId.make(name), revision: 1 })
    const span = (name: string) => ({ source: ref(name), start: 0, end: 4, quote: "Turn" })
    const memoryOf = (id: string, provenance: ReadonlyArray<string>, mentions: ReadonlyArray<string>): KnowledgeMemory => ({
      id: KnowledgeMemoryId.make(id), kind: "preference", text: `Prefers ${id}.`, entities: [], evidence: { _tag: "Stated" }, embedding: Option.none(), knownFrom: 1, knownTo: Option.none(),
      provenance: provenance.map(span), mentions: mentions.map(ref),
    })
    // The single preference also cites Monday's turn, for an entity's evidence: that never counts as stating it.
    const single = memoryOf("single", ["single", "monday"], ["single"])
    const repeated = memoryOf("repeated", ["monday", "tuesday", "friday"], ["monday", "tuesday", "friday"])
    const listed: ReadonlyArray<KnowledgeCandidate> = [single, repeated].map((memory) => ({ _tag: "Memory", memory, score: 1 }))
    const reads = yield* Ref.make(0)
    const services = Context.add(fixture.services, MemoryStore, {
      ...fixture.store, search: () => Effect.succeed({ lexical: listed, semantic: listed }),
      sourceInfo: (scope, refs) => Ref.update(reads, (count) => count + 1).pipe(Effect.andThen(fixture.store.sourceInfo(scope, refs))),
    })
    const recallWith = (config: MemoryConfig) => Layer.build(MemoryLive(config).pipe(Layer.provide(Layer.succeedContext(services)))).pipe(
      Effect.flatMap((context) => Context.get(context, LongTermMemory).recall({ scope: fixtureScope, query: "preference", limit: 8, maxChars: 8_000, graph: false })),
    )
    const ranked = (result: KnowledgeRecallResult) => result.candidates.map((candidate) => candidate._tag === "Memory" ? [String(candidate.memory.id), candidate.score, candidate.support] : [])
    // Plain fusion puts the single preference first (2/61 against 2/62); three episodes weigh 1 + 0.15 ln 3.
    const weighed = yield* recallWith(fixture.config)
    expect(ranked(weighed)).toEqual([
      ["repeated", (2 / 62) * (1 + 0.15 * Math.log(3)), { episodes: 3, sources: 3, firstSeen: Date.UTC(2026, 5, 1), lastSeen: Date.UTC(2026, 5, 3) }],
      ["single", 2 / 61, { episodes: 1, sources: 1, firstSeen: Date.UTC(2026, 5, 4), lastSeen: Date.UTC(2026, 5, 4) }],
    ])
    // One read for the pool's mentions, one for the result's sources.
    expect(yield* Ref.get(reads)).toBe(2)
    // A weight of 0 reads nothing more, ranks plainly and gives no support.
    yield* Ref.set(reads, 0)
    expect(ranked(yield* recallWith({ ...fixture.config, supportWeight: 0 }))).toEqual([["single", 2 / 61, undefined], ["repeated", 2 / 62, undefined]])
    expect(yield* Ref.get(reads)).toBe(1)
  }))))

  test("recall demotes and marks a goal or preference whose dated event has passed, never a fact; all ranks it plainly, and the profile leaves it out", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const opening = Date.UTC(2026, 2, 20, 10), afterwards = Date.UTC(2026, 4, 1, 12)
    // The extraction ties the preference to the exhibition's date, and states a second, current one.
    const extract = (prompt: string) => {
      const text = /<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? ""
      const extracted = fixtureExtraction(text)
      return JSON.stringify({ ...extracted, assertions: [], memories: extracted.memories.map((memory) => ({ ...memory, ...(text.includes("exhibition") ? { eventAt: { start: opening, end: null } } : {}) })) })
    }
    const fixture = yield* makeMemoryFixture(extract)
    yield* TestClock.setTime(Date.UTC(2026, 2, 2, 9))
    yield* fixture.memory.capture(fixtureEnqueue("exhibition", "I want to see the glass exhibition."))
    yield* fixture.memory.capture(fixtureEnqueue("pottery", "I want to take pottery classes."))
    expect(yield* fixture.memory.process(fixtureScope, 10)).toBe(2)
    const stored = (yield* fixture.store.snapshot(fixtureScope)).memories
    const exhibition = stored.find((memory) => memory.text.includes("exhibition"))!
    const pottery = stored.find((memory) => memory.text.includes("pottery"))!
    expect([exhibition.eventAt, "eventAt" in pottery]).toEqual([{ start: opening }, false])
    // Both arms list the exhibition first; a fact with the same past event is listed last.
    const fact: KnowledgeMemory = { ...exhibition, id: KnowledgeMemoryId.make("fact"), kind: "fact", text: "The exhibition opened in March." }
    const listed: ReadonlyArray<KnowledgeCandidate> = [exhibition, pottery, fact].map((memory) => ({ _tag: "Memory", memory, score: 1 }))
    const services = Context.add(fixture.services, MemoryStore, { ...fixture.store, search: () => Effect.succeed({ lexical: listed, semantic: listed }) })
    const engine = (config: MemoryConfig) => Layer.build(MemoryLive(config).pipe(Layer.provide(Layer.succeedContext(services)))).pipe(Effect.map((context) => Context.get(context, LongTermMemory)))
    const query: KnowledgeRecall = { scope: fixtureScope, query: "interests", limit: 8, maxChars: 8_000, graph: false }
    const ranked = (result: KnowledgeRecallResult) => result.candidates.map((candidate) => candidate._tag === "Memory" ? [candidate.memory.kind === "fact" ? "fact" : candidate.memory.text.includes("exhibition") ? "exhibition" : "pottery", candidate.score, candidate.past ?? false] : [])
    const memory = yield* engine(fixture.config)
    // Before the event nothing is past: plain fusion, and the profile holds both preferences.
    yield* TestClock.setTime(opening)
    expect(ranked(yield* memory.recall(query))).toEqual([["exhibition", 2 / 61, false], ["pottery", 2 / 62, false], ["fact", 2 / 63, false]])
    expect((yield* memory.profile(fixtureScope)).map((record) => record.id).toSorted(Order.String)).toEqual([exhibition.id, pottery.id].toSorted(Order.String))
    // After it the preference is demoted by half below the current one and marked past; the fact keeps its rank.
    yield* TestClock.setTime(afterwards)
    expect(ranked(yield* memory.recall(query))).toEqual([["pottery", 2 / 62, false], ["fact", 2 / 63, false], ["exhibition", (2 / 61) * 0.5, true]])
    expect((yield* memory.profile(fixtureScope)).map((record) => record.id)).toEqual([pottery.id])
    // all ranks it plainly and still marks it; so does a weight of 1; a valid time before the event reads it as current.
    expect(ranked(yield* memory.recall({ ...query, temporal: "all" }))).toEqual([["exhibition", 2 / 61, true], ["pottery", 2 / 62, false], ["fact", 2 / 63, false]])
    expect(ranked(yield* (yield* engine({ ...fixture.config, pastEventWeight: 1 })).recall(query))).toEqual([["exhibition", 2 / 61, true], ["pottery", 2 / 62, false], ["fact", 2 / 63, false]])
    expect(ranked(yield* memory.recall({ ...query, graph: { perspective: { validAt: opening - 1 }, depth: 1 } }))).toEqual([["exhibition", 2 / 61, false], ["pottery", 2 / 62, false], ["fact", 2 / 63, false]])
    // Without support the demotion still applies.
    expect(ranked(yield* (yield* engine({ ...fixture.config, supportWeight: 0 })).recall(query))[2]).toEqual(["exhibition", (2 / 61) * 0.5, true])
  })).pipe(Effect.provide(TestClock.layer()))))

  test("explicit graph opt-out performs no graph traversal", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const text = "I prefer tea."
    const fixture = yield* makeMemoryFixture([JSON.stringify(fixtureExtraction(text))])
    yield* fixture.memory.capture(fixtureEnqueue("graph-control", text))
    yield* fixture.memory.process(fixtureScope, 1)
    const traversals = yield* Ref.make(0)
    const services = Context.add(fixture.services, MemoryStore, { ...fixture.store, traverse: (query) => Ref.update(traversals, (count) => count + 1).pipe(Effect.andThen(fixture.store.traverse(query))) })
    const context = yield* Layer.build(MemoryLive(fixture.config).pipe(Layer.provide(Layer.succeedContext(services))))
    const memory = Context.get(context, LongTermMemory)
    const result = yield* memory.recall({ scope: fixtureScope, query: "tea", limit: 8, maxChars: 8_000, graph: false })
    expect(result.candidates).toHaveLength(1)
    expect(result.graph).toEqual({ entities: [], assertions: [], truncated: false })
    expect(yield* Ref.get(traversals)).toBe(0)
  }))))

  test("consolidation ablation keeps stated evidence and ignores inferred updates", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const text = "I prefer tea."
    const extracted = fixtureExtraction(text)
    const response = { ...extracted, memories: [
      { ...extracted.memories[0]!, supersedes: ["unknown-old-fact"] },
      { ...extracted.memories[0]!, key: "inference", kind: "profile", evidence: { _tag: "Inferred", supports: ["unknown-support"] }, supersedes: [], supersession: "change" },
    ] }
    const fixture = yield* makeMemoryFixture([JSON.stringify(response)], { consolidate: false })
    yield* fixture.memory.capture(fixtureEnqueue("ablation", text))
    yield* fixture.memory.process(fixtureScope, 1)
    const snapshot = yield* fixture.store.snapshot(fixtureScope)
    expect(snapshot.memories.map((memory) => memory.kind)).toEqual(["preference"])
    expect((yield* Ref.get(fixture.calls))[0]).toContain("Consolidation is disabled for this run.")
  }))))
})

describe("bounded memory extraction", () => {
  const filler = (word: string, count: number) => Array.from({ length: count }, (_, index) => `${word} ${index}.`).join(" ")
  const text = [`User: I prefer tea. ${filler("Chat", 70)}`, `User: I prefer green tea in the morning. ${filler("Talk", 60)}`, `User: I prefer tea without sugar. ${filler("Note", 75)}`].join("\n\n")
  const sourceOf = (prompt: string) => /<knowledge-source>\n([\s\S]*?)\n<\/knowledge-source>/.exec(prompt)?.[1] ?? ""
  /** One stated preference per part: its first sentence, at offsets within the part. */
  const reply = (prompt: string, call: Option.Option<{ readonly purpose: string }>) => {
    const purpose = Option.map(call, (value) => value.purpose)
    if (Option.contains(purpose, "plan")) return JSON.stringify({ queries: ["tea"], entities: [], validAt: null, knownAt: null })
    if (!Option.contains(purpose, "extract") && !Option.contains(purpose, "review")) return "not JSON"
    const part = sourceOf(prompt)
    const sentence = part.slice(part.indexOf("I prefer"), part.indexOf(".", part.indexOf("I prefer")) + 1)
    const span = { start: part.indexOf(sentence), end: part.indexOf(sentence) + sentence.length, quote: sentence }
    return JSON.stringify({
      entities: [{ key: "user", name: "User", type: "person", aliases: [], existing: null, spans: [{ start: part.indexOf("User"), end: part.indexOf("User") + 4, quote: "User" }] }],
      memories: [{ key: "preference", kind: "preference", text: sentence, entities: ["user"], spans: [span], evidence: { _tag: "Stated" }, supersedes: [], supersession: "change" }],
      assertions: [],
    })
  }

  test("a long source makes several bounded calls, each with its job context, and keeps exact provenance", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeMemoryFixture(reply, { review: true, maxExtractionChars: 1_000, maxSourceChars: 4_000, maxHelperOutputTokens: 256 })
    const job = yield* fixture.memory.capture(fixtureEnqueue("long", text))
    expect(yield* fixture.memory.process(fixtureScope, 1)).toBe(1)
    const windows = knowledgeExtractionWindows(text, 1_000)
    expect(windows.length).toBeGreaterThan(1)
    const prompts = yield* Ref.get(fixture.calls)
    expect(prompts).toHaveLength(windows.length * 2)
    expect(prompts.map(sourceOf)).toEqual(windows.flatMap((window) => [text.slice(window.start, window.end), text.slice(window.start, window.end)]))
    expect(yield* Ref.get(fixture.helperCalls)).toEqual(windows.flatMap(() => ["extract" as const, "review" as const]).map((purpose) => Option.some({
      purpose, scope: fixtureScope, job: Option.some({ id: KnowledgeJobId.make("job:long"), attempt: 1 }), maxOutputTokens: Option.some(256),
    })))
    expect(job.id).toBe(KnowledgeJobId.make("job:long"))
    const snapshot = yield* fixture.store.snapshot(fixtureScope)
    expect(snapshot.memories.map((memory) => memory.text)).toEqual(["I prefer tea.", "I prefer green tea in the morning.", "I prefer tea without sugar."].slice(0, windows.length))
    expect(snapshot.memories.flatMap((memory) => memory.provenance).every((span) => text.slice(span.start, span.end) === span.quote)).toBe(true)
    expect(snapshot.graph.entities).toHaveLength(1)
  }))))

  test("recall's planning and reranking calls carry their purpose and scope but no job", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fixture = yield* makeMemoryFixture(reply, { queryPlanning: true, rerank: true })
    yield* fixture.memory.capture(fixtureEnqueue("short", "User: I prefer tea."))
    yield* fixture.memory.process(fixtureScope, 1)
    yield* fixture.memory.recall({ scope: fixtureScope, query: "drink", limit: 8, maxChars: 8_000 })
    expect((yield* Ref.get(fixture.helperCalls)).slice(1)).toEqual([
      Option.some({ purpose: "plan", scope: fixtureScope, job: Option.none(), maxOutputTokens: Option.none() }),
      Option.some({ purpose: "rerank", scope: fixtureScope, job: Option.none(), maxOutputTokens: Option.none() }),
    ])
  }))))
})
