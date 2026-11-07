import { EmbeddingModel } from "effect/ai"
import { Cause, Clock, Context, Effect, Exit, Fiber, Layer, Match, Option, Queue, Ref, Result, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import {
  BackgroundWorkers, CurrentKnowledgeHelperCall, KNOWLEDGE_EXTRACTION_VERSION, knowledgeEngineId, KnowledgeError, KnowledgeExtraction,
  KnowledgeLeaseToken, LongTermMemory, MemoryStore, UtilityLlm,
  KnowledgeQueryPlan, KnowledgeRerank, applyKnowledgeRerank, budgetKnowledgeRecall, citedKnowledgeSources, knowledgeBm25,
  extractKnowledge, fuseKnowledgeCandidates, knowledgeQueryPrompt, knowledgeRerankPrompt, stageKnowledgeExtraction,
  isRetryableKnowledgeFailure, narrowKnowledgeGraph, traverseKnowledgeGraph, knowledgeNarrowingAdmits, narrowKnowledgeGraphBy,
  citesAdmittedKnowledge, knowledgeAssertionKey, knowledgeCandidateKey, knowledgeRecordDate, knowledgeMemoryMentions, knowledgeMemorySupport,
} from "@xandreed/core"
import type {
  KnowledgeEmbeddingSpace, KnowledgeEnqueue, KnowledgeHelperPurpose, KnowledgeJob, KnowledgeJobFailure, KnowledgeLease,
  KnowledgeRecall, KnowledgeRecallResult, KnowledgeScope, KnowledgeSnapshot, KnowledgeStage, KnowledgeVector,
  KnowledgeAssertion, KnowledgeCandidate, KnowledgeCandidates, KnowledgeMemory, KnowledgeRecallHistory, KnowledgeSubgraph, KnowledgeSupersession, KnowledgeSupport,
} from "@xandreed/core"
import type { MemoryConfig } from "./memory.entity.js"
import { memorySupportFactor } from "./memory.entity.functions.js"

const failure = (message: string, cause?: unknown) => new KnowledgeError({ reason: "Unavailable", message, ...(cause === undefined ? {} : { cause }) })
const decodeExtraction = (text: string) => Schema.decodeUnknownEffect(Schema.fromJsonString(KnowledgeExtraction))(text).pipe(
  Effect.mapError((cause) => new KnowledgeError({ reason: "Invalid", message: "The extraction model returned an invalid knowledge object", cause })),
)

/** Native extraction, graph reconciliation, consolidation, and hybrid memory recall. @public */
export const MemoryLive = (config: MemoryConfig) => Layer.effectContext(Effect.gen(function* () {
  const store = yield* MemoryStore
  const utility = yield* UtilityLlm
  const embeddings = yield* EmbeddingModel.EmbeddingModel
  const workerName = `memory-${yield* Effect.sync(() => crypto.randomUUID())}`
  const running = yield* SubscriptionRef.make(0)
  const accepting = yield* Ref.make(true)
  const wake = yield* Queue.sliding<void>(1)
  const admission = yield* Semaphore.make(1)
  const execution = yield* Semaphore.make(1)
  const active = yield* Ref.make<ReadonlyArray<Fiber.Fiber<unknown, unknown>>>([])
  const space: KnowledgeEmbeddingSpace = { model: config.embeddingModel, version: config.embeddingVersion, dimensions: config.embeddingDimensions }
  const engine = knowledgeEngineId(`memory:${KNOWLEDGE_EXTRACTION_VERSION}`, space)
  const inScope = (scope: KnowledgeScope) => scope.namespace === config.namespace && scope.collection === config.collection
    ? Effect.void : Effect.fail(new KnowledgeError({ reason: "Invalid", message: "Use the collection configured for this memory engine" }))

  const bounded = <A, E>(effect: Effect.Effect<A, E>, description: string) => effect.pipe(
    Effect.timeoutOrElse({ duration: config.modelTimeoutMs, orElse: () => Effect.fail(failure(description)) }),
  )
  /** One helper completion, with what it is for in `CurrentKnowledgeHelperCall`. */
  const ask = (prompt: string, purpose: KnowledgeHelperPurpose, scope: KnowledgeScope, job: Option.Option<KnowledgeJob>) => utility.complete(prompt).pipe(
    Effect.provideService(CurrentKnowledgeHelperCall, Option.some({
      purpose, scope, job: Option.map(job, (value) => ({ id: value.id, attempt: value.attempt })),
      maxOutputTokens: Option.fromNullishOr(config.maxHelperOutputTokens),
    })),
  )
  const complete = (job: KnowledgeJob) => (prompt: string, purpose: KnowledgeHelperPurpose) => bounded(ask(prompt, purpose, job.scope, Option.some(job)).pipe(Effect.mapError((cause) => failure("The memory model could not complete extraction", cause))), "The memory model exceeded its time budget").pipe(
    Effect.flatMap((result) => decodeExtraction(result.text)),
  )
  const vector = (values: ReadonlyArray<number>): Effect.Effect<KnowledgeVector, KnowledgeError> =>
    values.length === space.dimensions && values.every(Number.isFinite)
      ? Effect.succeed({ space, values })
      : Effect.fail(new KnowledgeError({ reason: "EmbeddingMismatch", message: "The embedding model returned an incompatible vector" }))

  const embedStage = (stage: KnowledgeStage): Effect.Effect<KnowledgeStage, KnowledgeError> => Effect.gen(function* () {
    const missing = stage.memories.filter((memory) => Option.isNone(memory.embedding))
    if (missing.length === 0) return stage
    const result = yield* bounded(embeddings.embedMany(missing.map((memory) => memory.text)).pipe(
      Effect.mapError((cause) => failure("Memory embedding failed", cause)),
    ), "Memory embedding exceeded its time budget")
    if (result.embeddings.length !== missing.length) return yield* Effect.fail(new KnowledgeError({ reason: "EmbeddingMismatch", message: "Memory embedding returned the wrong number of vectors" }))
    const vectors = yield* Effect.forEach(result.embeddings, (embedding) => vector(embedding.vector), { concurrency: 1 })
    const indexed = new Map(missing.flatMap((memory, index) => vectors[index] === undefined ? [] : [[memory.id, vectors[index]] as const]))
    return { ...stage, memories: stage.memories.map((memory) => ({ ...memory, embedding: Option.orElse(memory.embedding, () => Option.fromNullishOr(indexed.get(memory.id))) })) }
  })

  const extract = (job: KnowledgeJob, snapshot: KnowledgeSnapshot): Effect.Effect<KnowledgeStage, KnowledgeError> => Effect.gen(function* () {
    const source = yield* store.source(job.scope, job.source)
    if (Option.isNone(source)) return yield* Effect.fail(new KnowledgeError({ reason: "Invalid", message: "The source of the memory job is unavailable" }))
    if (source.value.text.length > config.maxSourceChars) return yield* Effect.fail(new KnowledgeError({ reason: "Invalid", message: "Split the source into smaller evidence records before capture" }))
    const reviewed = yield* extractKnowledge({
      source: source.value, snapshot, mode: "memory", maxContextChars: config.maxCandidateChars, maxExtractionChars: config.maxExtractionChars,
      consolidate: config.consolidate, review: config.review, complete: complete(job),
    })
    const reconciled = config.consolidate ? reviewed : {
      ...reviewed,
      memories: reviewed.memories.filter((memory) => memory.evidence._tag === "Stated").map((memory) => ({ ...memory, supersedes: [] })),
      assertions: reviewed.assertions.map((assertion) => ({ ...assertion, supersedes: [] })),
    }
    return yield* stageKnowledgeExtraction(source.value, snapshot, reconciled, yield* Clock.currentTimeMillis)
  })

  const leaseOf = (job: KnowledgeJob, token: KnowledgeLeaseToken): Effect.Effect<KnowledgeLease> => Clock.currentTimeMillis.pipe(
    Effect.map((now) => ({ scope: job.scope, jobId: job.id, token, now })),
  )
  const work = (job: KnowledgeJob, token: KnowledgeLeaseToken): Effect.Effect<void, KnowledgeError> => Effect.gen(function* () {
    const snapshot = yield* store.snapshot(job.scope)
    const staged = Option.filter(job.stage, (stage) => stage.expectedVersion === snapshot.version)
    const stage = Option.isSome(staged) ? staged.value : yield* extract(job, snapshot)
    yield* store.renew(yield* leaseOf(job, token), config.leaseMs)
    yield* store.stage(yield* leaseOf(job, token), stage)
    const embedded = yield* embedStage(stage)
    yield* store.renew(yield* leaseOf(job, token), config.leaseMs)
    yield* store.stage(yield* leaseOf(job, token), embedded)
    yield* store.publish(yield* leaseOf(job, token))
  })

  const attempt = (scope: KnowledgeScope, requested?: KnowledgeJob): Effect.Effect<number, KnowledgeError> => Effect.gen(function* () {
    const token = KnowledgeLeaseToken.make(yield* Effect.sync(() => crypto.randomUUID()))
    const currentFiber = yield* Effect.fiber
    const decision = yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const admitted = yield* admission.withPermits(1)(Effect.gen(function* () {
        if (!(yield* Ref.get(accepting))) return false
        yield* Ref.update(active, (fibers) => [...fibers, currentFiber])
        yield* SubscriptionRef.update(running, (count) => count + 1)
        return true
      }))
      if (!admitted) return { _tag: "Empty" as const }
      return yield* Effect.gen(function* () {
        // Count uncertain claims before storage I/O; stop never waits on that I/O while holding admission.
        const claimed = yield* store.claim({ scope, engine, worker: workerName, token, now: yield* Clock.currentTimeMillis, leaseMs: config.leaseMs, ...(requested === undefined ? {} : { jobId: requested.id }) })
        if (Option.isNone(claimed)) return { _tag: "Empty" as const }
        const job = claimed.value
        const heartbeat = Effect.forever(Effect.sleep(Math.max(1, Math.floor(config.leaseMs / 3))).pipe(
          Effect.andThen(Effect.suspend(() => leaseOf(job, token).pipe(Effect.flatMap((lease) => store.renew(lease, config.leaseMs))))),
        ))
        const outcome = yield* Effect.exit(restore(Effect.raceFirst(work(job, token), heartbeat)))
        return yield* Exit.match(outcome, {
          onSuccess: () => Effect.succeed({ _tag: "Complete" as const }),
          onFailure: (cause) => Effect.gen(function* () {
            const interrupted = Cause.hasInterrupts(cause)
            const current = yield* store.status(scope, job.id).pipe(Effect.catchCause((readFailure) => Effect.logWarning("The memory job status could not be checked after processing stopped", readFailure).pipe(Effect.as(Option.none<KnowledgeJob>()))))
            if (!interrupted && Option.exists(current, (value) => value.phase._tag === "Complete")) return { _tag: "Complete" as const }
            const error = Option.getOrElse(Cause.findErrorOption(cause), () => failure(interrupted ? "Memory processing was interrupted before publication" : "Memory processing stopped unexpectedly", cause))
            const failed: KnowledgeJobFailure = { reason: error.reason, message: error.message, step: "Required" }
            const recorded = yield* store.fail(yield* leaseOf(job, token), failed).pipe(Effect.result)
            if (Result.isFailure(recorded)) yield* Effect.logWarning("The memory processing failure could not be recorded", recorded.failure)
            if (interrupted) {
              if (Result.isSuccess(recorded)) yield* store.retry(scope, job.id).pipe(Effect.ignore({ log: "Warn", message: "Interrupted memory work could not be returned to the processing queue" }))
              return yield* Effect.failCause(cause)
            }
            if (Result.isSuccess(recorded) && job.attempt < config.maxAttempts && isRetryableKnowledgeFailure(failed)) {
              yield* store.retry(scope, job.id)
              return { _tag: "Retry" as const, job }
            }
            return yield* Effect.fail(error)
          }),
        })
      }).pipe(Effect.ensuring(Ref.update(active, (fibers) => fibers.filter((fiber) => fiber.id !== currentFiber.id)).pipe(
        Effect.andThen(SubscriptionRef.update(running, (count) => count - 1)),
      )))
    }))
    return yield* Match.valueTags(decision, {
      Retry: ({ job }) => attempt(scope, job), Complete: () => Effect.succeed(1), Empty: () => Effect.succeed(0),
    })
  })
  const processOne = (scope: KnowledgeScope, requested?: KnowledgeJob) => execution.withPermits(1)(attempt(scope, requested))
  const process = Effect.fn("memory.process")(function* (scope: KnowledgeScope, limit: number) {
    yield* inScope(scope)
    const amounts = yield* Effect.forEach(Array.from({ length: Math.max(0, Math.min(100, Math.floor(limit))) }), () => processOne(scope), { concurrency: 1 })
    return amounts.reduce((sum, amount) => sum + amount, 0)
  })
  /**
   * The earlier states the recalled current records replaced, one hop back along their `replaces` links of the
   * supersessions `follows` admits: a memory read by id, a relation from the snapshot recall already read (narrowed as
   * the graph is). A link whose record is gone (its source was forgotten), is still current, or cites a revision
   * outside the narrowing is skipped. `until` is a change's ended validity for a relation, else when its successor was said.
   */
  const earlierStates = Effect.fnUntraced(function* (input: KnowledgeRecall, candidates: ReadonlyArray<KnowledgeCandidate>, graph: KnowledgeSubgraph, snapshot: KnowledgeSnapshot, follows: (supersession: KnowledgeSupersession) => boolean) {
    const memoryLinks = candidates.flatMap((candidate) => candidate._tag === "Memory"
      ? (candidate.memory.replaces ?? []).filter((link) => follows(link.supersession)).map((link) => ({ successor: candidate.memory, link })) : [])
    const assertionLinks = graph.assertions.flatMap((successor) => (successor.replaces ?? []).filter((link) => follows(link.supersession)).map((link) => ({ successor, link })))
    if (memoryLinks.length === 0 && assertionLinks.length === 0) return []
    const memories = (yield* Effect.forEach(memoryLinks, ({ successor, link }) => store.memory(input.scope, link.id).pipe(
      Effect.map(Option.map((record) => ({ successor, link, record }))),
    ), { concurrency: 4 })).flatMap(Option.toArray).filter(({ record }) => Option.isSome(record.knownTo))
    const assertions = assertionLinks.flatMap(({ successor, link }) => snapshot.graph.assertions.filter((record) => record.id === link.id && (Option.isSome(record.knownTo) || Option.isSome(record.validTo)))
      .map((record) => ({ successor, link, record })))
    const successors: ReadonlyArray<KnowledgeMemory | KnowledgeAssertion> = [...memories.map(({ successor }) => successor), ...assertions.map(({ successor }) => successor)]
    const refs = [
      ...successors.flatMap((successor) => Option.toArray(Option.fromNullishOr(successor.provenance[0])).map((span) => span.source)),
      ...(input.metadata === undefined ? [] : memories.flatMap(({ record }) => record.provenance.map((span) => span.source))),
    ]
    const infos = refs.length === 0 ? [] : yield* store.sourceInfo(input.scope, refs)
    const admits = knowledgeNarrowingAdmits(input, infos)
    const saidAt = (successor: KnowledgeMemory | KnowledgeAssertion) => Option.getOrElse(knowledgeRecordDate(successor.provenance, infos), () => successor.knownFrom)
    return [
      ...memories.filter(({ record }) => citesAdmittedKnowledge(record.provenance, admits)).map(({ successor, link, record }): KnowledgeRecallHistory => ({
        _tag: "Memory", successor: knowledgeCandidateKey({ _tag: "Memory", memory: successor, score: 0 }), record, supersession: link.supersession, until: saidAt(successor),
      })),
      ...assertions.map(({ successor, link, record }): KnowledgeRecallHistory => ({
        _tag: "Assertion", successor: knowledgeAssertionKey(successor), record, supersession: link.supersession,
        until: link.supersession === "change" ? Option.getOrElse(record.validTo, () => saidAt(successor)) : saidAt(successor),
      })),
    ]
  })
  /**
   * Fuse the searches' lists, weighing each memory by how often it was stated (`supportWeight`): the plain fused pool's
   * memories have their mentioned revisions' info read in one batch, the lists are fused again with each memory's
   * support factor, and every memory of the result carries its `support`. A weight of 0 reads nothing and fuses plainly.
   */
  const fuseBySupport = Effect.fnUntraced(function* (scope: KnowledgeScope, lists: ReadonlyArray<KnowledgeCandidates>, limit: number, maxChars: number) {
    const pool = fuseKnowledgeCandidates(lists, limit, maxChars)
    const memories = pool.flatMap((candidate) => candidate._tag === "Memory" ? [candidate.memory] : [])
    const mentioned = memories.flatMap(knowledgeMemoryMentions)
    if (config.supportWeight === 0 || mentioned.length === 0) return pool
    const infos = yield* store.sourceInfo(scope, mentioned)
    const supports = new Map(memories.flatMap((memory) => Option.toArray(knowledgeMemorySupport(memory, infos)).map((support): readonly [string, KnowledgeSupport] => [memory.id, support])))
    const supported = (candidate: KnowledgeCandidate): KnowledgeCandidate => Match.valueTags(candidate, {
      Memory: (memory) => Option.match(Option.fromNullishOr(supports.get(memory.memory.id)), { onNone: () => memory, onSome: (support) => ({ ...memory, support }) }),
      Chunk: (chunk) => chunk,
    })
    return fuseKnowledgeCandidates(lists, limit, maxChars, (candidate) => memorySupportFactor(supported(candidate), config.supportWeight)).map(supported)
  })
  const recall = Effect.fn("memory.recall")(function* (input: KnowledgeRecall) {
    yield* inScope(input.scope)
    const { sources, metadata } = input
    if (sources !== undefined && sources.length === 0) return { candidates: [], graph: { entities: [], assertions: [], truncated: false }, history: [], sources: [] } satisfies KnowledgeRecallResult
    const now = yield* Clock.currentTimeMillis
    const fallback: KnowledgeQueryPlan = { queries: [input.query], entities: [], validAt: Option.none(), knownAt: Option.none() }
    const plan = config.queryPlanning ? yield* ask(knowledgeQueryPrompt(input.query, now), "plan", input.scope, Option.none()).pipe(
      Effect.flatMap((completion) => Schema.decodeUnknownEffect(Schema.fromJsonString(KnowledgeQueryPlan))(completion.text)),
      Effect.timeout(Math.max(1, Math.floor(config.retrievalTimeoutMs / 4))),
      Effect.catch((error) => Effect.logWarning("Memory query planning failed; using the original question", error).pipe(Effect.as(fallback))),
    ) : fallback
    const queries = [...new Set([input.query, ...plan.queries])].slice(0, 4)
    const graphOptions = input.graph === false ? undefined : input.graph
    const perspective = { validAt: graphOptions?.perspective.validAt ?? Option.getOrElse(plan.validAt, () => now), knownAt: graphOptions?.perspective.knownAt ?? Option.getOrElse(plan.knownAt, () => now) }
    const candidateLimit = Math.min(100, Math.max(input.limit * 4, 32))
    const results = yield* Effect.forEach(queries, (query) => Effect.gen(function* () {
      const embedded = yield* embeddings.embed(query).pipe(
        Effect.mapError((cause) => failure("Memory query embedding failed", cause)),
        Effect.timeoutOrElse({ duration: Math.max(1, Math.floor(config.retrievalTimeoutMs / 4)), orElse: () => Effect.fail(failure("Memory query embedding exceeded its time budget")) }),
        Effect.flatMap((response) => vector(response.vector)), Effect.map(Option.some),
        Effect.catchIf((error) => error.reason === "Unavailable", (error) => Effect.logWarning("Memory query embedding is unavailable; using lexical evidence", error).pipe(Effect.as(Option.none()))),
      )
      return yield* store.search({ scope: input.scope, query, vector: embedded, limit: candidateLimit, knownAt: Option.some(perspective.knownAt), ...(sources === undefined ? {} : { sources }), ...(metadata === undefined ? {} : { metadata }) })
    }), { concurrency: 2 })
    // Each query's lexical and semantic lists are ranked on their own: a memory a planned query finds first ranks as one the question finds first.
    const fused = yield* fuseBySupport(input.scope, results, candidateLimit, input.maxChars * 4)
    const stored = yield* store.snapshot(input.scope)
    // A source or metadata filter narrows the graph before seeding and traverses it here, as the store would; a metadata
    // filter reads the info of the revisions the graph cites.
    const narrowed = metadata !== undefined
      ? narrowKnowledgeGraphBy(stored.graph, knowledgeNarrowingAdmits(input, yield* store.sourceInfo(input.scope, citedKnowledgeSources({ candidates: [], graph: stored.graph }))))
      : sources === undefined ? stored.graph : narrowKnowledgeGraph(stored.graph, sources)
    const snapshot = { ...stored, graph: narrowed }
    const scores = knowledgeBm25([input.query, ...plan.entities].join(" "), snapshot.graph.entities.map((entity) => [entity.name, ...entity.aliases].join(" ")))
    const matched = snapshot.graph.entities.filter((_, index) => (scores[index] ?? 0) > 0).map((entity) => entity.id)
    const seeds = [...matched, ...fused.flatMap((candidate) => Match.valueTags(candidate, { Memory: ({ memory }) => memory.entities, Chunk: () => [] }))]
    const graph = input.graph === false || seeds.length === 0
      ? { entities: [], assertions: [], truncated: false }
      : sources === undefined && metadata === undefined ? yield* store.traverse({ scope: input.scope, seeds: [...new Set(seeds)], perspective, depth: graphOptions?.depth ?? config.graphDepth, limit: 100 })
        : traverseKnowledgeGraph(snapshot.graph, { scope: input.scope, seeds: [...new Set(seeds)], perspective, depth: graphOptions?.depth ?? config.graphDepth, limit: 100 })
    const ranked: ReadonlyArray<KnowledgeCandidate> = config.rerank && fused.length > 0 ? yield* ask(knowledgeRerankPrompt(input.query, fused, graph, config.maxCandidateChars), "rerank", input.scope, Option.none()).pipe(
      Effect.flatMap((completion) => Schema.decodeUnknownEffect(Schema.fromJsonString(KnowledgeRerank))(completion.text)),
      Effect.flatMap((order) => Option.match(applyKnowledgeRerank(fused, order), { onNone: () => Effect.fail(failure("Memory reranking returned an unknown evidence key")), onSome: Effect.succeed })),
      Effect.timeout(Math.max(1, Math.floor(config.retrievalTimeoutMs / 4))),
      Effect.catch((error) => Effect.logWarning("Memory reranking failed; using deterministic retrieval ranks", error).pipe(Effect.as(fused))),
    ) : fused
    const selected = ranked.reduce((current, candidate) => {
      const text = Match.valueTags(candidate, { Memory: ({ memory }) => memory.text, Chunk: ({ chunk }) => chunk.text })
      return current.items.length < input.limit && current.used + text.length <= input.maxChars
        ? { items: [...current.items, candidate], used: current.used + text.length } : current
    }, { items: [] as ReadonlyArray<KnowledgeCandidate>, used: 0 })
    const mode = input.history ?? "changes"
    const earlier = mode === "none" ? [] : yield* earlierStates(input, selected.items, graph, snapshot, (supersession) => mode === "all" || supersession === "change")
    const bounded = budgetKnowledgeRecall({ candidates: selected.items, graph, history: earlier, sources: [] }, input.maxChars, input.limit, input.historyShare)
    return { ...bounded, sources: yield* store.sourceInfo(input.scope, citedKnowledgeSources(bounded)) }
  }, Effect.timeoutOrElse({ duration: config.retrievalTimeoutMs, orElse: () => Effect.fail(failure("Memory retrieval exceeded its time budget")) }))
  const capture = Effect.fn("memory.capture")(function* (input: KnowledgeEnqueue) {
    yield* inScope(input.source.scope)
    if (input.source.text.length > config.maxSourceChars) return yield* Effect.fail(new KnowledgeError({ reason: "Invalid", message: "Split the source into smaller evidence records before capture" }))
    const job = yield* store.enqueue({ ...input, engine })
    yield* Queue.offer(wake, undefined)
    return job
  })
  const service = LongTermMemory.of({
    capture, process, recall,
    forget: Effect.fn("memory.forget")((scope, id) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => store.forget(scope, id, now)))),
    status: store.status,
    // A host's retry starts the job over under this engine's id: its attempts reset, a job failed under an older id included.
    retry: Effect.fn("memory.retry")((scope, id) => inScope(scope).pipe(Effect.andThen(store.requeue({ scope, jobId: id, engine })), Effect.tap(() => Queue.offer(wake, undefined)))),
    source: store.source,
    profile: Effect.fn("memory.profile")((scope) => store.snapshot(scope).pipe(Effect.map((snapshot) => snapshot.memories.filter((memory) => Option.isNone(memory.knownTo) && (memory.kind === "preference" || memory.kind === "profile"))))),
  })

  const drain = Effect.gen(function* () {
    // The idle scan runs every poll: untraced, so an idle worker records nothing; each claimed job is traced.
    const pending = yield* store.pending({ engine, namespace: config.namespace, collection: config.collection, now: yield* Clock.currentTimeMillis, limit: config.batchSize }).pipe(Effect.withTracerEnabled(false))
    yield* Effect.forEach(pending.filter((job) => job.scope.collection === config.collection), (job) => processOne(job.scope, job).pipe(
      Effect.ignore({ log: "Warn", message: "A memory source remains unprocessed; inspect its processing status before retrying" }),
    ), { concurrency: 1 })
  })
  const fiber = config.worker ? Option.some(yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
    if (yield* Ref.get(accepting)) yield* drain.pipe(Effect.ignore({ log: "Warn", message: "The memory worker could not scan durable processing jobs" }))
    yield* Effect.raceFirst(Effect.sleep(config.pollMs), Queue.take(wake))
  })))) : Option.none()
  const stop = Ref.set(accepting, false).pipe(Effect.andThen(admission.withPermits(1)(Effect.void)))
  const interrupt = stop.pipe(Effect.andThen(Effect.gen(function* () {
    const caller = yield* Effect.fiberId
    const fibers = [...(yield* Ref.get(active)), ...Option.toArray(fiber)]
    yield* Fiber.interruptAll([...new Map(fibers.filter((current) => current.id !== caller).map((current) => [current.id, current])).values()])
  })))
  const worker = {
    id: `@xandreed/plugin-memory/${config.namespace}/${config.collection}`,
    running: SubscriptionRef.get(running),
    idle: SubscriptionRef.changes(running).pipe(Stream.filter((count) => count === 0), Stream.take(1), Stream.runDrain),
    stop, interrupt,
  }
  yield* Effect.addFinalizer(() => interrupt)
  return Context.merge(Context.make(LongTermMemory, service), Context.make(BackgroundWorkers, [worker]))
}))
