import { EmbeddingModel } from "effect/ai"
import { Cause, Clock, Context, Effect, Exit, Fiber, Layer, Match, Option, Predicate, Queue, Ref, Result, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import {
  BackgroundWorkers, CurrentKnowledgeHelperCall, extractKnowledge, fuseKnowledgeCandidates, isRetryableKnowledgeFailure, KNOWLEDGE_EXTRACTION_VERSION, knowledgeEngineId, Knowledge, KnowledgeError,
  knowledgeFailureAttributes, knowledgeJobFailure,
  KnowledgeLeaseToken, KnowledgeStore, stageKnowledgeExtraction, UtilityLlm,
  applyKnowledgeRerank, citedKnowledgeSources, knowledgeCandidateText, KnowledgeQueryPlan, knowledgeQueryPrompt, KnowledgeRerank, knowledgeRerankPrompt,
  knowledgeNarrowingAdmits, narrowKnowledgeGraph, narrowKnowledgeGraphBy, traverseKnowledgeGraph,
} from "@xandreed/core"
import type {
  KnowledgeEmbeddingSpace, KnowledgeEnqueue, KnowledgeEntityId, KnowledgeFailureDiagnostic, KnowledgeHelperPurpose, KnowledgeJob, KnowledgeLease, KnowledgeRecall, KnowledgeScope,
  KnowledgeSnapshot, KnowledgeSource, KnowledgeStage, KnowledgeSubgraph, KnowledgeVector,
} from "@xandreed/core"
import { RagGraphFailed } from "./rag.entity.js"
import type { RagConfig } from "./rag.entity.js"
import { chunkDocument } from "./rag.entity.functions.js"

const unavailable = (message: string, cause?: unknown) => new KnowledgeError({ reason: "Unavailable", message, ...(cause === undefined ? {} : { cause }) })
const knowledgeFailure = (failure: KnowledgeError | RagGraphFailed): KnowledgeError => Predicate.isTagged(failure, "RagGraphFailed") ? failure.failure : failure
/** Where and how an extraction failed, without its content, on the span that processed the job. */
const annotateFailure = (diagnostic: KnowledgeFailureDiagnostic | undefined) => diagnostic === undefined ? Effect.void : Effect.annotateCurrentSpan(knowledgeFailureAttributes(diagnostic))

/** Native staged ingestion and hybrid retrieval over the host's document store. @public */
export const RagLive = (config: RagConfig) => Layer.effectContext(Effect.gen(function* () {
  const store = yield* KnowledgeStore
  const embeddings = yield* EmbeddingModel.EmbeddingModel
  const utility = yield* Effect.serviceOption(UtilityLlm)
  if (config.graph && Option.isNone(utility)) return yield* Effect.fail(new KnowledgeError({ reason: "Invalid", message: "Graph extraction requires a UtilityLlm" }))
  if (Option.isNone(utility) && (config.queryPlanning || config.rerank)) yield* Effect.logDebug("Document retrieval uses hybrid ranking without a utility model")
  const name = `rag-${yield* Effect.sync(() => crypto.randomUUID())}`
  const running = yield* SubscriptionRef.make(0)
  const accepting = yield* Ref.make(true)
  const wake = yield* Queue.sliding<void>(1)
  const admission = yield* Semaphore.make(1)
  const execution = yield* Semaphore.make(1)
  const active = yield* Ref.make<ReadonlyArray<Fiber.Fiber<unknown, unknown>>>([])
  const space: KnowledgeEmbeddingSpace = { model: config.embeddingModel, version: config.embeddingVersion, dimensions: config.embeddingDimensions }
  const engine = knowledgeEngineId(`rag:${KNOWLEDGE_EXTRACTION_VERSION}`, space)
  const bounded = <A, E>(effect: Effect.Effect<A, E>, message: string) => effect.pipe(Effect.timeoutOrElse({ duration: config.modelTimeoutMs, orElse: () => Effect.fail(unavailable(message)) }))
  const inScope = (scope: KnowledgeScope) => scope.namespace === config.namespace && scope.collection === config.collection
    ? Effect.void : Effect.fail(new KnowledgeError({ reason: "Invalid", message: "Use the collection configured for this retrieval engine" }))
  const vector = (values: ReadonlyArray<number>): Effect.Effect<KnowledgeVector, KnowledgeError> => values.length === space.dimensions && values.every(Number.isFinite)
    ? Effect.succeed({ space, values }) : Effect.fail(new KnowledgeError({ reason: "EmbeddingMismatch", message: "The embedding service returned an incompatible vector" }))
  /** One helper completion, with what it is for in `CurrentKnowledgeHelperCall`. */
  const ask = (model: typeof UtilityLlm.Service, prompt: string, purpose: KnowledgeHelperPurpose, scope: KnowledgeScope, job: Option.Option<KnowledgeJob>) => model.complete(prompt).pipe(
    Effect.provideService(CurrentKnowledgeHelperCall, Option.some({
      purpose, scope, job: Option.map(job, (value) => ({ id: value.id, attempt: value.attempt })),
      maxOutputTokens: Option.fromNullishOr(config.maxHelperOutputTokens),
    })),
  )
  /** One graph extraction or review completion; `extractKnowledge` decodes it, and records where and how a reply that does not decode failed. */
  const complete = (job: KnowledgeJob) => (prompt: string, purpose: KnowledgeHelperPurpose) => Option.match(utility, {
    onNone: () => Effect.fail(new KnowledgeError({ reason: "Invalid", message: "Graph extraction requires a UtilityLlm" })),
    onSome: (model) => bounded(ask(model, prompt, purpose, job.scope, Option.some(job)).pipe(Effect.mapError((cause) => unavailable("Document graph extraction failed", cause))), "Document graph extraction exceeded its time budget"),
  })
  const askQuery = <A, I>(schema: Schema.Codec<A, I>, prompt: string, purpose: KnowledgeHelperPurpose, scope: KnowledgeScope) => Option.match(utility, {
    onNone: () => Effect.succeed(Option.none<A>()),
    onSome: (model) => ask(model, prompt, purpose, scope, Option.none()).pipe(
      Effect.timeout(Math.max(1, Math.floor(config.queryTimeoutMs / 4))),
      Effect.flatMap((result) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(result.text)),
      Effect.catchDefect((cause) => Effect.fail(unavailable("Document query assistance encountered an unexpected failure", cause))),
      Effect.tapError((cause) => Effect.logWarning("Document query assistance was unavailable; hybrid ranking remains available", cause)),
      Effect.option,
    ),
  })
  const extractGraph = (job: KnowledgeJob, source: KnowledgeSource, snapshot: KnowledgeSnapshot): Effect.Effect<KnowledgeStage, KnowledgeError> => Effect.gen(function* () {
    const reviewed = yield* extractKnowledge({
      source, snapshot, mode: "document", maxContextChars: config.maxCandidateChars, maxExtractionChars: config.maxExtractionChars,
      consolidate: true, review: config.review, complete: complete(job),
    })
    if (reviewed.memories.length > 0) return yield* Effect.fail(new KnowledgeError({ reason: "Invalid", message: "Document extraction must not create personal memories", diagnostic: { stage: "stage" } }))
    return yield* stageKnowledgeExtraction(source, snapshot, reviewed, yield* Clock.currentTimeMillis)
  }).pipe(Effect.catchDefect((cause) => Effect.fail(unavailable("Document graph extraction encountered an unexpected failure", cause))))
  // The graph is optional: a failed extraction is retried with the job, and its last attempt publishes the chunks without it.
  const extract = (job: KnowledgeJob, source: KnowledgeSource, snapshot: KnowledgeSnapshot, last: boolean): Effect.Effect<KnowledgeStage, KnowledgeError | RagGraphFailed> => Effect.gen(function* () {
    const chunks = chunkDocument(source, config.chunkChars, config.overlapChars)
    const plain: KnowledgeStage = { expectedVersion: snapshot.version, memories: [], chunks, entities: [], assertions: [], retireMemories: [], retireAssertions: [] }
    if (!config.graph) return plain
    const graph = yield* Effect.result(extractGraph(job, source, snapshot))
    if (Result.isSuccess(graph)) return { ...graph.success, chunks }
    if (!last) return yield* Effect.fail(new RagGraphFailed({ failure: graph.failure }))
    yield* Effect.logWarning("Document graph extraction failed on the last attempt; the source's chunks publish without its graph", graph.failure)
    yield* annotateFailure(graph.failure.diagnostic)
    return { ...plain, notes: [{ _tag: "GraphOmitted" as const, reason: graph.failure.reason, message: graph.failure.message }] }
  })
  const embed = (stage: KnowledgeStage): Effect.Effect<KnowledgeStage, KnowledgeError> => Effect.gen(function* () {
    const missing = stage.chunks.filter((chunk) => Option.isNone(chunk.embedding))
    const batches = Array.from({ length: Math.ceil(missing.length / config.embeddingBatchSize) }, (_, index) => missing.slice(index * config.embeddingBatchSize, (index + 1) * config.embeddingBatchSize))
    const parts = yield* Effect.forEach(batches, (batch) => Effect.gen(function* () {
      const response = yield* bounded(embeddings.embedMany(batch.map((chunk) => chunk.text)).pipe(Effect.mapError((cause) => unavailable("Document embedding failed", cause))), "Document embedding exceeded its time budget")
      if (response.embeddings.length !== batch.length) return yield* Effect.fail(new KnowledgeError({ reason: "EmbeddingMismatch", message: "Document embedding returned the wrong number of vectors" }))
      return yield* Effect.forEach(response.embeddings, (entry, index) => vector(entry.vector).pipe(Effect.map((embedding) => ({ id: batch[index]?.id, embedding }))), { concurrency: 1 })
    }), { concurrency: 1 })
    const vectors = new Map(parts.flat().flatMap((part) => part.id === undefined ? [] : [[part.id, part.embedding] as const]))
    return { ...stage, chunks: stage.chunks.map((chunk) => ({ ...chunk, embedding: Option.orElse(chunk.embedding, () => Option.fromNullishOr(vectors.get(chunk.id))) })) }
  })
  const lease = (job: KnowledgeJob, token: KnowledgeLeaseToken): Effect.Effect<KnowledgeLease> => Clock.currentTimeMillis.pipe(Effect.map((now) => ({ scope: job.scope, jobId: job.id, token, now })))
  const work = (job: KnowledgeJob, token: KnowledgeLeaseToken): Effect.Effect<void, KnowledgeError | RagGraphFailed> => Effect.gen(function* () {
    const snapshot = yield* store.snapshot(job.scope)
    const previous = Option.filter(job.stage, (stage) => stage.expectedVersion === snapshot.version)
    const stage = yield* Option.match(previous, { onSome: Effect.succeed, onNone: () => store.source(job.scope, job.source).pipe(Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new KnowledgeError({ reason: "Invalid", message: "The document source is unavailable" })),
      onSome: (source) => extract(job, source, snapshot, job.attempt >= config.maxAttempts),
    }))) })
    yield* store.stage(yield* lease(job, token), stage)
    const embedded = yield* embed(stage)
    yield* store.stage(yield* lease(job, token), embedded)
    yield* store.publish(yield* lease(job, token))
  })
  const attempt = (scope: KnowledgeScope, requested?: KnowledgeJob): Effect.Effect<number, KnowledgeError> => Effect.gen(function* () {
    const token = KnowledgeLeaseToken.make(yield* Effect.sync(() => crypto.randomUUID()))
    const currentFiber = yield* Effect.fiber
    const decision: Option.Option<Option.Option<KnowledgeJob>> = yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const admitted = yield* admission.withPermits(1)(Effect.gen(function* () {
        if (!(yield* Ref.get(accepting))) return false
        yield* Ref.update(active, (fibers) => [...fibers, currentFiber])
        yield* SubscriptionRef.update(running, (count) => count + 1)
        return true
      }))
      if (!admitted) return Option.none<Option.Option<KnowledgeJob>>()
      return yield* Effect.gen(function* () {
        // Count uncertain claims before storage I/O; stop never waits on that I/O while holding admission.
        const claimed = yield* store.claim({ scope, engine, worker: name, token, now: yield* Clock.currentTimeMillis, leaseMs: config.leaseMs, ...(requested === undefined ? {} : { jobId: requested.id }) })
        if (Option.isNone(claimed)) return Option.none<Option.Option<KnowledgeJob>>()
        const job = claimed.value
        const heartbeat = Effect.forever(Effect.sleep(Math.max(1, Math.floor(config.leaseMs / 3))).pipe(Effect.andThen(Effect.suspend(() => lease(job, token).pipe(Effect.flatMap((current) => store.renew(current, config.leaseMs)))))))
        const outcome = yield* Effect.exit(restore(Effect.raceFirst(work(job, token), heartbeat)))
        return yield* Exit.match(outcome, {
          onSuccess: () => Effect.succeed(Option.some(Option.none<KnowledgeJob>())),
          onFailure: (cause) => Effect.gen(function* () {
            const interrupted = Cause.hasInterrupts(cause)
            const status = yield* store.status(scope, job.id).pipe(Effect.result)
            if (!interrupted && Result.isSuccess(status) && Option.exists(status.success, (current) => current.phase._tag === "Complete")) return Option.some(Option.none<KnowledgeJob>())
            const found = Cause.findErrorOption(cause)
            const graphFailed = Option.exists(found, Predicate.isTagged("RagGraphFailed"))
            const error = Option.match(found, {
              onNone: () => unavailable(interrupted ? "Document processing was interrupted before publication" : "Document processing stopped unexpectedly", cause),
              onSome: knowledgeFailure,
            })
            const failure = knowledgeJobFailure(error, graphFailed ? "Graph" : "Required")
            yield* annotateFailure(failure.diagnostic)
            const recorded = yield* store.fail(yield* lease(job, token), failure).pipe(Effect.result)
            if (Result.isFailure(recorded)) yield* Effect.logWarning("The document processing failure could not be recorded", recorded.failure)
            if (interrupted) {
              if (Result.isSuccess(recorded)) yield* store.retry(scope, job.id).pipe(Effect.ignore({ log: "Warn", message: "Interrupted document work could not be returned to the processing queue" }))
              return yield* Effect.failCause(Cause.map(cause, knowledgeFailure))
            }
            if (Result.isSuccess(recorded) && job.attempt < config.maxAttempts && isRetryableKnowledgeFailure(failure)) {
              yield* store.retry(scope, job.id)
              return Option.some(Option.some(job))
            }
            return yield* Effect.fail(error)
          }),
        })
      }).pipe(Effect.ensuring(Ref.update(active, (fibers) => fibers.filter((fiber) => fiber.id !== currentFiber.id)).pipe(Effect.andThen(SubscriptionRef.update(running, (count) => count - 1)))))
    }))
    return yield* Option.match(decision, {
      onNone: () => Effect.succeed(0),
      onSome: (retry) => Option.match(retry, { onNone: () => Effect.succeed(1), onSome: (job) => attempt(scope, job) }),
    })
  })
  const processOne = (scope: KnowledgeScope, requested?: KnowledgeJob) => execution.withPermits(1)(attempt(scope, requested))
  const process = Effect.fn("rag.process")(function* (scope: KnowledgeScope, limit: number) {
    yield* inScope(scope)
    return (yield* Effect.forEach(Array.from({ length: Math.max(0, Math.min(100, Math.floor(limit))) }), () => processOne(scope), { concurrency: 1 })).reduce((sum, count) => sum + count, 0)
  })
  const retrieve = Effect.fn("rag.retrieve")(function* (input: KnowledgeRecall) {
    yield* inScope(input.scope)
    const { sources, metadata } = input
    if (sources !== undefined && sources.length === 0) return { candidates: [], graph: { entities: [], assertions: [], truncated: false }, history: [], sources: [] }
    const now = yield* Clock.currentTimeMillis
    const plan = config.queryPlanning ? yield* askQuery(KnowledgeQueryPlan, knowledgeQueryPrompt(input.query, now), "plan", input.scope) : Option.none()
    const queries = [...new Set([input.query, ...Option.match(plan, { onNone: () => [], onSome: (value) => value.queries })])].slice(0, 4)
    const expansion = typeof input.graph === "object" ? input.graph : undefined
    const plannedValid = Option.flatMap(plan, (value) => value.validAt)
    const plannedKnown = Option.flatMap(plan, (value) => value.knownAt)
    const perspective = {
      validAt: expansion?.perspective.validAt ?? Option.getOrElse(plannedValid, () => now),
      knownAt: expansion?.perspective.knownAt ?? Option.getOrElse(plannedKnown, () => now),
    }
    const poolLimit = Math.min(100, input.limit * 4)
    const queryVectors = yield* embeddings.embedMany(queries).pipe(
      Effect.mapError((cause) => unavailable("Document query embedding failed", cause)),
      Effect.timeoutOrElse({ duration: Math.max(1, Math.floor(config.queryTimeoutMs / 4)), orElse: () => Effect.fail(unavailable("Document query embedding exceeded its time budget")) }),
      Effect.flatMap((response) => Effect.forEach(response.embeddings, (entry) => vector(entry.vector), { concurrency: 1 })),
      Effect.tapError((cause) => Effect.logWarning("Document query embedding was unavailable; lexical search remains available", cause)), Effect.option,
    )
    const arms = yield* Effect.forEach(queries, (query, index) => store.search({ scope: input.scope, query,
      vector: Option.flatMap(queryVectors, (vectors) => Option.fromNullishOr(vectors[index])), limit: poolLimit,
      knownAt: Option.some(perspective.knownAt), ...(sources === undefined ? {} : { sources }), ...(metadata === undefined ? {} : { metadata }),
      ...(config.minSimilarity === undefined ? {} : { minSimilarity: config.minSimilarity }),
    }), { concurrency: 1 })
    // Each query's lists, narrowed to passages, are ranked on their own: a passage a planned query finds first ranks as one the question finds first.
    const pooled = fuseKnowledgeCandidates(arms.map((arm) => ({ lexical: arm.lexical.filter((entry) => entry._tag === "Chunk"), semantic: arm.semantic.filter((entry) => entry._tag === "Chunk") })), poolLimit, config.maxCandidateChars)
    const graph = expansion === undefined ? { entities: [], assertions: [], truncated: false } : yield* Effect.gen(function* () {
      const stored = yield* store.snapshot(input.scope)
      // A source or metadata filter narrows the graph before seeding and traverses it here, as the store would; a metadata
      // filter reads the info of the revisions the graph cites.
      const narrowed = metadata !== undefined
        ? narrowKnowledgeGraphBy(stored.graph, knowledgeNarrowingAdmits(input, yield* store.sourceInfo(input.scope, citedKnowledgeSources({ candidates: [], graph: stored.graph }))))
        : sources === undefined ? stored.graph : narrowKnowledgeGraph(stored.graph, sources)
      const snapshot = { ...stored, graph: narrowed }
      const spans = pooled.flatMap((candidate) => Match.valueTags(candidate, { Memory: () => [], Chunk: ({ chunk }) => [chunk.provenance] }))
      const evidenceEdges = snapshot.graph.assertions.filter((edge) => edge.provenance.some((span) => spans.some((chunk) => chunk.source.id === span.source.id && chunk.source.revision === span.source.revision && chunk.start < span.end && span.start < chunk.end)))
      const names = [input.query, ...Option.match(plan, { onNone: () => [], onSome: (value) => value.entities })].join(" ").toLowerCase()
      const named = snapshot.graph.entities.filter((entity) => [entity.name, ...entity.aliases].some((name) => names.includes(name.toLowerCase()))).map((entity) => entity.id)
      const seeds: ReadonlyArray<KnowledgeEntityId> = [...new Set(named.length > 0 ? named : evidenceEdges.map((edge) => edge.subject))].slice(0, 100)
      const traversal = { scope: input.scope, seeds, perspective, depth: expansion.depth, limit: poolLimit }
      return seeds.length === 0 ? { entities: [], assertions: [], truncated: false }
        : sources === undefined && metadata === undefined ? yield* store.traverse(traversal) : traverseKnowledgeGraph(snapshot.graph, traversal)
    })
    const rerank = config.rerank && pooled.length > 0 ? yield* askQuery(KnowledgeRerank, knowledgeRerankPrompt(input.query, pooled, graph, config.maxCandidateChars), "rerank", input.scope) : Option.none()
    const checkedOrder = Option.flatMap(rerank, (result) => applyKnowledgeRerank(pooled, result))
    if (Option.isSome(rerank) && Option.isNone(checkedOrder)) yield* Effect.logWarning("Document reranking proposed an unknown or repeated identity; hybrid evidence was retained")
    const ordered = Option.getOrElse(checkedOrder, () => pooled)
    const candidateBudget = expansion === undefined ? input.maxChars : Math.max(1, Math.floor(input.maxChars * 0.75))
    const candidates = ordered.reduce((state, candidate) => state.items.length < input.limit && state.used + knowledgeCandidateText(candidate).length <= candidateBudget
      ? { used: state.used + knowledgeCandidateText(candidate).length, items: [...state.items, candidate] } : state, { used: 0, items: [] as typeof pooled }).items
    const used = candidates.reduce((sum, candidate) => sum + knowledgeCandidateText(candidate).length, 0)
    const kept = graph.assertions.reduce((state, edge) => state.used + edge.text.length <= input.maxChars ? { used: state.used + edge.text.length, assertions: [...state.assertions, edge] } : state, { used, assertions: [] as KnowledgeSubgraph["assertions"] })
    // Document retrieval returns current evidence only: `history` stays empty, whatever the recall asks.
    const evidence = { candidates, graph: { ...graph, assertions: kept.assertions, truncated: graph.truncated || kept.assertions.length < graph.assertions.length }, history: [] }
    return { ...evidence, sources: yield* store.sourceInfo(input.scope, citedKnowledgeSources(evidence)) }
  }, Effect.timeoutOrElse({ duration: config.queryTimeoutMs, orElse: () => Effect.fail(unavailable("Document retrieval exceeded its time budget")) }))
  const ingest = Effect.fn("rag.ingest")(function* (input: KnowledgeEnqueue) {
    yield* inScope(input.source.scope)
    if (input.source.text.length > config.maxSourceChars) return yield* Effect.fail(new KnowledgeError({ reason: "Invalid", message: "Split the document into smaller sources before ingestion" }))
    const job = yield* store.enqueue({ ...input, engine })
    yield* Queue.offer(wake, undefined)
    return job
  })
  const service = Knowledge.of({
    ingest, process, retrieve, source: store.source, status: store.status,
    // A host's retry starts the job over under this engine's id: its attempts reset, a job failed under an older id included.
    retry: Effect.fn("rag.retry")((scope, id) => inScope(scope).pipe(Effect.andThen(store.requeue({ scope, jobId: id, engine })), Effect.tap(() => Queue.offer(wake, undefined)))),
    forget: Effect.fn("rag.forget")((scope, id) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => store.forget(scope, id, now)))),
  })
  const drain = Effect.gen(function* () {
    // The idle scan runs every poll: untraced, so an idle worker records nothing; each claimed job is traced.
    const pending = yield* store.pending({ engine, namespace: config.namespace, collection: config.collection, now: yield* Clock.currentTimeMillis, limit: config.batchSize }).pipe(Effect.withTracerEnabled(false))
    yield* Effect.forEach(pending.filter((job) => job.scope.collection === config.collection), (job) => processOne(job.scope, job).pipe(Effect.ignore({ log: "Warn", message: "A document source remains unprocessed; inspect its processing status before retrying" })), { concurrency: 1, discard: true })
  })
  const fiber = config.worker ? Option.some(yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
    if (yield* Ref.get(accepting)) yield* drain.pipe(Effect.ignore({ log: "Warn", message: "The document worker could not scan durable processing jobs" }))
    yield* Effect.raceFirst(Effect.sleep(config.pollMs), Queue.take(wake))
  })))) : Option.none()
  const stop = Ref.set(accepting, false).pipe(Effect.andThen(admission.withPermits(1)(Effect.void)))
  const interrupt = stop.pipe(Effect.andThen(Effect.gen(function* () {
    const caller = yield* Effect.fiberId
    const fibers = [...(yield* Ref.get(active)), ...Option.toArray(fiber)]
    yield* Fiber.interruptAll([...new Map(fibers.filter((current) => current.id !== caller).map((current) => [current.id, current])).values()])
  })))
  const worker = {
    id: `@xandreed/plugin-rag/${config.namespace}/${config.collection}`,
    running: SubscriptionRef.get(running), idle: SubscriptionRef.changes(running).pipe(Stream.filter((count) => count === 0), Stream.take(1), Stream.runDrain),
    stop, interrupt,
  }
  yield* Effect.addFinalizer(() => interrupt)
  return Context.merge(Context.make(Knowledge, service), Context.make(BackgroundWorkers, [worker]))
}))
