import { Effect, Layer, Match, Option, Order, Ref, Result } from "effect"
import {
  KnowledgeError,
  type KnowledgeAssertion, type KnowledgeCandidate, type KnowledgeChunk, type KnowledgeEntity,
  type KnowledgeJob, type KnowledgeLease, type KnowledgeMemory, type KnowledgeScope,
  type KnowledgeSource, type KnowledgeSourceId, type KnowledgeSnapshot, type KnowledgeStage,
} from "./knowledge.entity.js"
import {
  knowledgeBm25, knowledgeCandidateKey, knowledgeCandidateText, knowledgeCandidateWithin, knowledgeCosine,
  sameEmbeddingSpace, sameKnowledgeScope, traverseKnowledgeGraph, validateKnowledgeStage,
} from "./knowledge.entity.functions.js"
import { KnowledgeStore, MemoryStore, TemporalGraph, type KnowledgeIndex } from "../ports/knowledge.port.js"

interface ScopeData {
  readonly scope: KnowledgeScope
  readonly version: number
  readonly memories: ReadonlyArray<KnowledgeMemory>
  readonly chunks: ReadonlyArray<KnowledgeChunk>
  readonly entities: ReadonlyArray<KnowledgeEntity>
  readonly assertions: ReadonlyArray<KnowledgeAssertion>
}
interface State {
  readonly sources: ReadonlyArray<KnowledgeSource>
  readonly jobs: ReadonlyArray<KnowledgeJob>
  readonly scopes: ReadonlyArray<ScopeData>
  readonly tombstones: ReadonlyArray<{ readonly scope: KnowledgeScope; readonly id: KnowledgeSourceId }>
  readonly identities: ReadonlyArray<{ readonly scope: KnowledgeScope; readonly kind: string; readonly id: string; readonly source: KnowledgeSource["ref"] }>
}
const empty: State = { sources: [], jobs: [], scopes: [], tombstones: [], identities: [] }
const scoped = (state: State, scope: KnowledgeScope): ScopeData => state.scopes.find((entry) => sameKnowledgeScope(entry.scope, scope)) ?? { scope, version: 0, memories: [], chunks: [], entities: [], assertions: [] }
const snapshotOf = (data: ScopeData): KnowledgeSnapshot => ({ version: data.version, memories: data.memories, graph: { entities: data.entities, assertions: data.assertions, truncated: false } })
const replaceScope = (state: State, data: ScopeData): State => ({ ...state, scopes: [...state.scopes.filter((entry) => !sameKnowledgeScope(entry.scope, data.scope)), data] })
const replaceJob = (state: State, job: KnowledgeJob): State => ({ ...state, jobs: state.jobs.map((entry) => entry.id === job.id && sameKnowledgeScope(entry.scope, job.scope) ? job : entry) })
const tombstoned = (state: State, scope: KnowledgeScope, id: KnowledgeSourceId): boolean => state.tombstones.some((entry) => entry.id === id && sameKnowledgeScope(entry.scope, scope))
const latest = (state: State, scope: KnowledgeScope, id: KnowledgeSourceId): Option.Option<KnowledgeSource> => Option.fromNullishOr(state.sources.filter((source) => source.ref.id === id && sameKnowledgeScope(source.scope, scope)).toSorted((a, b) => b.ref.revision - a.ref.revision)[0])
const error = (reason: KnowledgeError["reason"], message: string): KnowledgeError => new KnowledgeError({ reason, message })
const claimable = (job: KnowledgeJob, now: number): boolean => Match.valueTags(job.phase, {
  Queued: () => true, Processing: ({ leaseUntil }) => leaseUntil <= now,
  Failed: () => false, Complete: () => false, Cancelled: () => false,
})
const ownedJob = (state: State, lease: KnowledgeLease): Result.Result<KnowledgeJob, KnowledgeError> => {
  const job = state.jobs.find((entry) => entry.id === lease.jobId && sameKnowledgeScope(entry.scope, lease.scope))
  if (!job) return Result.fail(error("LeaseLost", "The processing job does not exist in this scope"))
  return Match.valueTags(job.phase, {
    Processing: ({ token, leaseUntil }) => token === lease.token && leaseUntil > lease.now
      ? Result.succeed(job) : Result.fail(error("LeaseLost", "The processing lease expired or belongs to another worker")),
    Queued: () => Result.fail(error("LeaseLost", "The processing job is queued")),
    Failed: () => Result.fail(error("LeaseLost", "The processing job failed")),
    Complete: () => Result.fail(error("LeaseLost", "The processing job already completed")),
    Cancelled: () => Result.fail(error("LeaseLost", "The processing job was cancelled")),
  })
}
const closeDependents = (memories: ReadonlyArray<KnowledgeMemory>, initial: ReadonlyArray<string>): ReadonlyArray<string> => {
  const expanded = [...new Set([...initial, ...memories.filter((memory) => Match.valueTags(memory.evidence, {
    Stated: () => false, Inferred: ({ supports }) => supports.some((id) => initial.includes(id)),
  })).map((memory) => memory.id)])]
  return expanded.length === initial.length ? expanded : closeDependents(memories, expanded)
}
const references = (memory: KnowledgeMemory | KnowledgeAssertion, id: KnowledgeSourceId): boolean => memory.provenance.some((span) => span.source.id === id)
const forgetClosure = (state: State, data: ScopeData, sources: ReadonlyArray<KnowledgeSourceId>): {
  readonly sources: ReadonlyArray<KnowledgeSourceId>
  readonly memories: ReadonlyArray<string>
  readonly assertions: ReadonlyArray<string>
  readonly entities: ReadonlyArray<string>
} => {
  const owned = (kind: string, id: string): boolean => state.identities.some((identity) => sameKnowledgeScope(identity.scope, data.scope) && identity.kind === kind && identity.id === id && sources.includes(identity.source.id))
  const entities = data.entities.filter((entity) => entity.provenance.some((span) => sources.includes(span.source.id))).map((entity) => entity.id)
  const memories = closeDependents(data.memories, data.memories.filter((memory) => owned("memory", memory.id) || sources.some((id) => references(memory, id)) || memory.entities.some((entity) => entities.includes(entity))).map((memory) => memory.id))
  const assertions: ReadonlyArray<string> = data.assertions.filter((edge) => owned("assertion", edge.id) || sources.some((id) => references(edge, id)) || entities.includes(edge.subject) || Match.valueTags(edge.object, { Entity: ({ entityId }) => entities.includes(entityId), Value: () => false })).map((edge) => edge.id)
  const expanded = [...new Set([
    ...sources,
    ...data.memories.filter((memory) => memories.includes(memory.id)).flatMap((memory) => memory.provenance.map((span) => span.source.id)),
    ...data.assertions.filter((edge) => assertions.includes(edge.id)).flatMap((edge) => edge.provenance.map((span) => span.source.id)),
    ...data.entities.filter((entity) => entities.includes(entity.id)).flatMap((entity) => entity.provenance.map((span) => span.source.id)),
    ...state.identities.filter((identity) => sameKnowledgeScope(identity.scope, data.scope) && (identity.kind === "memory" && memories.includes(identity.id) || identity.kind === "assertion" && assertions.includes(identity.id))).map((identity) => identity.source.id),
  ])]
  return expanded.length === sources.length ? { sources: expanded, memories, assertions, entities } : forgetClosure(state, data, expanded)
}
const collides = (state: State, data: ScopeData, stage: KnowledgeStage, source: KnowledgeSource["ref"]): boolean =>
  stage.memories.some((memory) => data.memories.some((prior) => prior.id === memory.id)) ||
  stage.chunks.some((chunk) => data.chunks.some((prior) => prior.id === chunk.id)) ||
  stage.assertions.some((edge) => data.assertions.some((prior) => prior.id === edge.id)) ||
  stage.entities.some((entity) => data.entities.some((prior) => prior.id === entity.id && (prior.name !== entity.name || prior.type !== entity.type))) ||
  state.identities.some((identity) => sameKnowledgeScope(identity.scope, data.scope) && (identity.source.id !== source.id || identity.source.revision !== source.revision) && (
    identity.kind === "memory" && stage.memories.some((memory) => memory.id === identity.id) ||
    identity.kind === "chunk" && stage.chunks.some((chunk) => chunk.id === identity.id) ||
    identity.kind === "assertion" && stage.assertions.some((edge) => edge.id === identity.id)
  ))
const mergeEntities = (existing: ReadonlyArray<KnowledgeEntity>, incoming: ReadonlyArray<KnowledgeEntity>): ReadonlyArray<KnowledgeEntity> => incoming.reduce((all, entity) => {
  const prior = all.find((item) => item.id === entity.id)
  const merged = prior ? { ...entity, aliases: [...new Set([...prior.aliases, ...entity.aliases])].toSorted(Order.String), provenance: [...prior.provenance, ...entity.provenance].filter((span, index, spans) => spans.findIndex((other) => JSON.stringify(other) === JSON.stringify(span)) === index) } : entity
  return [...all.filter((item) => item.id !== entity.id), merged]
}, existing)

/** A deterministic reference implementation of the durable index contract. @public */
export const makeKnowledgeIndexMemory = Effect.fnUntraced(function* () {
  const state = yield* Ref.make<State>(empty)
  const change = <A>(decide: (current: State) => Result.Result<{ readonly state: State; readonly value: A }, KnowledgeError>): Effect.Effect<A, KnowledgeError> =>
    Ref.modify(state, (current) => Result.match(decide(current), {
      onFailure: (failure): readonly [Result.Result<A, KnowledgeError>, State] => [Result.fail(failure), current],
      onSuccess: ({ state: next, value }): readonly [Result.Result<A, KnowledgeError>, State] => [Result.succeed(value), next],
    })).pipe(Effect.flatMap(Effect.fromResult))
  const read = <A>(select: (current: State) => A): Effect.Effect<A> => Ref.get(state).pipe(Effect.map(select))
  const leased = <A>(lease: KnowledgeLease, decide: (current: State, job: KnowledgeJob) => Result.Result<{ readonly state: State; readonly value: A }, KnowledgeError>) =>
    change((current) => Result.flatMap(ownedJob(current, lease), (job) => decide(current, job)))
  const index: KnowledgeIndex = {
    enqueue: Effect.fn("knowledge_store.enqueue")(function* (input) {
      return yield* change((current) => {
        const scope = input.source.scope
        if (tombstoned(current, scope, input.source.ref.id)) return Result.fail(error("Tombstoned", "The source was forgotten"))
        const priorJob = current.jobs.find((job) => job.id === input.jobId && sameKnowledgeScope(job.scope, scope))
        const priorSource = current.sources.find((source) => sameKnowledgeScope(source.scope, scope) && source.ref.id === input.source.ref.id && source.ref.revision === input.source.ref.revision)
        const same = priorSource && JSON.stringify(priorSource) === JSON.stringify(input.source)
        if (priorJob) return same && priorJob.engine === input.engine && priorJob.source.id === input.source.ref.id && priorJob.source.revision === input.source.ref.revision
          ? Result.succeed({ state: current, value: priorJob }) : Result.fail(error("Conflict", "The job identity belongs to different source content"))
        const replay = current.jobs.find((job) => sameKnowledgeScope(job.scope, scope) && job.source.id === input.source.ref.id && job.source.revision === input.source.ref.revision && job.engine === input.engine)
        if (replay) return same ? Result.succeed({ state: current, value: replay }) : Result.fail(error("Conflict", "The source revision already has different content"))
        if (priorSource && !same) return Result.fail(error("Conflict", "The source revision is immutable"))
        const previous = latest(current, scope, input.source.ref.id)
        const validRevision = Option.match(previous, {
          onNone: () => Option.isNone(input.expectedRevision),
          onSome: (source) => same || Option.contains(input.expectedRevision, source.ref.revision) && input.source.ref.revision > source.ref.revision,
        })
        if (!validRevision) return Result.fail(error("Conflict", "The source revision changed before enqueue"))
        const job: KnowledgeJob = { id: input.jobId, scope, source: input.source.ref, engine: input.engine, attempt: 0, phase: { _tag: "Queued" }, stage: Option.none() }
        const jobs = current.jobs.map((entry): KnowledgeJob => sameKnowledgeScope(entry.scope, scope) && entry.source.id === input.source.ref.id && entry.source.revision < input.source.ref.revision && entry.phase._tag !== "Complete"
          ? { ...entry, phase: { _tag: "Cancelled", cancelledAt: input.source.recordedAt } } : entry)
        return Result.succeed({ state: { ...current, sources: priorSource ? current.sources : [...current.sources, input.source], jobs: [...jobs, job] }, value: job })
      })
    }),
    claim: Effect.fn("knowledge_store.claim")(function* (input) {
      return yield* change((current) => {
        const job = current.jobs.find((entry) => sameKnowledgeScope(entry.scope, input.scope) && entry.engine === input.engine && (!input.jobId || entry.id === input.jobId) && claimable(entry, input.now))
        if (!job) return Result.succeed({ state: current, value: Option.none<KnowledgeJob>() })
        const claimed: KnowledgeJob = { ...job, attempt: job.attempt + 1, phase: { _tag: "Processing", token: input.token, worker: input.worker, leaseUntil: input.now + input.leaseMs } }
        return Result.succeed({ state: replaceJob(current, claimed), value: Option.some(claimed) })
      })
    }),
    pending: Effect.fn("knowledge_store.pending")((input) => read((current) => current.jobs.filter((job) => job.engine === input.engine && job.scope.namespace === input.namespace && (input.collection === undefined || job.scope.collection === input.collection) && claimable(job, input.now)).slice(0, input.limit))),
    renew: Effect.fn("knowledge_store.renew")((lease, leaseMs) => leased(lease, (current, job) => {
      const phase = job.phase
      return Match.valueTags(phase, {
        Processing: (processing) => {
          const renewed: KnowledgeJob = { ...job, phase: { ...processing, leaseUntil: lease.now + leaseMs } }
          return Result.succeed({ state: replaceJob(current, renewed), value: renewed })
        },
        Queued: () => Result.fail(error("LeaseLost", "The processing job is queued")), Failed: () => Result.fail(error("LeaseLost", "The processing job failed")),
        Complete: () => Result.fail(error("LeaseLost", "The processing job completed")), Cancelled: () => Result.fail(error("LeaseLost", "The processing job was cancelled")),
      })
    })),
    stage: Effect.fn("knowledge_store.stage")((lease, stage) => leased(lease, (current, job) => {
      const data = scoped(current, lease.scope)
      if (data.version !== stage.expectedVersion) return Result.fail(error("Conflict", "The scope changed after extraction"))
      const validation = validateKnowledgeStage(stage, snapshotOf(data), current.sources.filter((source) => sameKnowledgeScope(source.scope, lease.scope) && !tombstoned(current, lease.scope, source.ref.id)))
      if (Option.isSome(validation)) return Result.fail(validation.value)
      return Result.succeed({ state: replaceJob(current, { ...job, stage: Option.some(stage) }), value: undefined })
    })),
    publish: Effect.fn("knowledge_store.publish")((lease) => change((current) => {
      const completed = current.jobs.find((job) => job.id === lease.jobId && sameKnowledgeScope(job.scope, lease.scope) && job.phase._tag === "Complete")
      if (completed) return Result.succeed({ state: current, value: undefined })
      return Result.flatMap(ownedJob(current, lease), (job) => Option.match(job.stage, {
        onNone: () => Result.fail(error("Conflict", "The staged extraction is unavailable; reconcile the current scope before publication")),
        onSome: (stage) => {
          const source = latest(current, lease.scope, job.source.id)
          if (tombstoned(current, lease.scope, job.source.id)) return Result.fail(error("Tombstoned", "The source was forgotten"))
          if (!Option.exists(source, (document) => document.ref.revision === job.source.revision)) return Result.fail(error("Conflict", "A later source revision superseded this job"))
          const data = scoped(current, lease.scope)
          if (data.version !== stage.expectedVersion) return Result.fail(error("Conflict", "The scope changed after extraction"))
          const validation = validateKnowledgeStage(stage, snapshotOf(data), current.sources.filter((document) => sameKnowledgeScope(document.scope, lease.scope) && !tombstoned(current, lease.scope, document.ref.id)))
          if (Option.isSome(validation)) return Result.fail(validation.value)
          if (collides(current, data, stage, job.source)) return Result.fail(error("Conflict", "A staged immutable identity already exists"))
          const spaces = [...data.memories.flatMap((memory) => Option.toArray(memory.embedding)), ...data.chunks.flatMap((chunk) => Option.toArray(chunk.embedding)), ...stage.memories.flatMap((memory) => Option.toArray(memory.embedding)), ...stage.chunks.flatMap((chunk) => Option.toArray(chunk.embedding))].map((vector) => vector.space)
          if (spaces.some((space) => spaces[0] && !sameEmbeddingSpace(spaces[0], space))) return Result.fail(error("EmbeddingMismatch", "The index has a different embedding identity"))
          const replacedMemory = data.memories.filter((memory) => memory.provenance.some((span) => span.source.id === job.source.id && span.source.revision !== job.source.revision)).map((memory) => memory.id)
          const closed = closeDependents(data.memories, [...new Set([...replacedMemory, ...stage.retireMemories])])
          const next: ScopeData = {
            ...data, version: data.version + 1,
            memories: [...data.memories.map((memory) => closed.includes(memory.id) && Option.isNone(memory.knownTo) ? { ...memory, knownTo: Option.some(lease.now) } : memory), ...stage.memories.map((memory) => ({ ...memory, knownFrom: lease.now, knownTo: Option.none<number>() }))],
            chunks: [...data.chunks.filter((chunk) => chunk.provenance.source.id !== job.source.id), ...stage.chunks],
            entities: mergeEntities(data.entities, stage.entities),
            assertions: [...data.assertions.map((edge) => (stage.retireAssertions.includes(edge.id) || edge.provenance.some((span) => span.source.id === job.source.id && span.source.revision !== job.source.revision)) && Option.isNone(edge.knownTo) ? { ...edge, knownTo: Option.some(lease.now) } : edge), ...stage.assertions.map((edge) => ({ ...edge, knownFrom: lease.now, knownTo: Option.none<number>() }))],
          }
          const done: KnowledgeJob = { ...job, phase: { _tag: "Complete", publishedAt: lease.now } }
          const identities = [
            ...stage.memories.map((memory) => ({ kind: "memory", id: String(memory.id) })),
            ...stage.chunks.map((chunk) => ({ kind: "chunk", id: String(chunk.id) })),
            ...stage.assertions.map((edge) => ({ kind: "assertion", id: String(edge.id) })),
          ].map((identity) => ({ ...identity, scope: lease.scope, source: job.source }))
          return Result.succeed({ state: { ...replaceJob(replaceScope(current, next), done), identities: [...current.identities, ...identities] }, value: undefined })
        },
      }))
    })),
    fail: Effect.fn("knowledge_store.fail")((lease, message) => leased(lease, (current, job) => Result.succeed({ state: replaceJob(current, { ...job, phase: { _tag: "Failed", message } }), value: undefined }))),
    retry: Effect.fn("knowledge_store.retry")((scope, jobId) => change((current) => {
      const job = current.jobs.find((entry) => entry.id === jobId && sameKnowledgeScope(entry.scope, scope))
      if (!job || job.phase._tag !== "Failed") return Result.fail(error("Conflict", "Only a failed job may be retried"))
      if (tombstoned(current, scope, job.source.id)) return Result.fail(error("Tombstoned", "The source was forgotten"))
      const queued: KnowledgeJob = { ...job, phase: { _tag: "Queued" } }
      return Result.succeed({ state: replaceJob(current, queued), value: queued })
    })),
    status: Effect.fn("knowledge_store.status")((scope, id) => read((current) => Option.fromNullishOr(current.jobs.find((job) => job.id === id && sameKnowledgeScope(job.scope, scope))))),
    snapshot: Effect.fn("knowledge_store.snapshot")((scope) => read((current) => snapshotOf(scoped(current, scope)))),
    search: Effect.fn("knowledge_store.search")(function* (query) {
      const data = yield* read((current) => scoped(current, query.scope))
      const memories = data.memories.filter((memory) => Option.match(query.knownAt, {
        onNone: () => Option.isNone(memory.knownTo),
        onSome: (time) => memory.knownFrom <= time && Option.match(memory.knownTo, { onNone: () => true, onSome: (until) => time < until }),
      }))
      const stored: ReadonlyArray<KnowledgeCandidate> = [...memories.map((memory): KnowledgeCandidate => ({ _tag: "Memory", memory, score: 0 })), ...data.chunks.map((chunk): KnowledgeCandidate => ({ _tag: "Chunk", chunk, score: 0 }))]
      const sources = query.sources
      const candidates = sources === undefined ? stored : stored.filter((candidate) => knowledgeCandidateWithin(candidate, sources))
      const scores = knowledgeBm25(query.query, candidates.map(knowledgeCandidateText))
      const lexical = candidates.map((candidate, position) => ({ ...candidate, score: scores[position] ?? 0 })).filter((candidate) => candidate.score > 0).toSorted((a, b) => b.score - a.score || Order.String(knowledgeCandidateKey(a), knowledgeCandidateKey(b))).slice(0, query.limit)
      const embeddings = stored.flatMap((candidate) => Match.valueTags(candidate, { Memory: ({ memory }) => Option.toArray(memory.embedding), Chunk: ({ chunk }) => Option.toArray(chunk.embedding) }))
      if (Option.isSome(query.vector) && embeddings.some((embedding) => !sameEmbeddingSpace(embedding.space, query.vector._tag === "Some" ? query.vector.value.space : embedding.space))) return yield* Effect.fail(error("EmbeddingMismatch", "The query embedding does not match the index"))
      const semantic = Option.match(query.vector, {
        onNone: () => [],
        onSome: (vector) => candidates.flatMap((candidate) => Match.valueTags(candidate, {
          Memory: ({ memory }) => Option.toArray(memory.embedding).map((embedding) => ({ ...candidate, score: knowledgeCosine(vector, embedding) })),
          Chunk: ({ chunk }) => Option.toArray(chunk.embedding).map((embedding) => ({ ...candidate, score: knowledgeCosine(vector, embedding) })),
        })).filter((candidate) => candidate.score > 0).toSorted((a, b) => b.score - a.score || Order.String(knowledgeCandidateKey(a), knowledgeCandidateKey(b))).slice(0, query.limit),
      })
      return { lexical, semantic }
    }),
    source: Effect.fn("knowledge_store.source")((scope, ref) => read((current) => tombstoned(current, scope, ref.id) ? Option.none() : Option.fromNullishOr(current.sources.find((source) => sameKnowledgeScope(source.scope, scope) && source.ref.id === ref.id && source.ref.revision === ref.revision)))),
    sourceInfo: Effect.fn("knowledge_store.source_info")((scope, refs) => read((current) => refs.flatMap((ref, index) => {
      const first = refs.findIndex((other) => other.id === ref.id && other.revision === ref.revision) === index
      const found = first && !tombstoned(current, scope, ref.id) ? current.sources.find((source) => sameKnowledgeScope(source.scope, scope) && source.ref.id === ref.id && source.ref.revision === ref.revision) : undefined
      return found === undefined ? [] : [{ ref: found.ref, occurredAt: found.occurredAt, recordedAt: found.recordedAt, metadata: found.metadata }]
    }))),
    memory: Effect.fn("knowledge_store.memory")((scope, id) => read((current) => Option.fromNullishOr(scoped(current, scope).memories.find((memory) => memory.id === id)))),
    chunk: Effect.fn("knowledge_store.chunk")((scope, id) => read((current) => Option.fromNullishOr(scoped(current, scope).chunks.find((chunk) => chunk.id === id)))),
    forget: Effect.fn("knowledge_store.forget")((scope, id, now) => change((current) => {
      if (tombstoned(current, scope, id)) return Result.succeed({ state: current, value: undefined })
      const data = scoped(current, scope)
      const removed = forgetClosure(current, data, [id])
      const next: ScopeData = {
        ...data, version: data.version + 1,
        memories: data.memories.filter((memory) => !removed.memories.includes(memory.id)),
        chunks: data.chunks.filter((chunk) => !removed.sources.includes(chunk.provenance.source.id)),
        entities: data.entities.filter((entity) => !removed.entities.includes(entity.id)),
        assertions: data.assertions.filter((edge) => !removed.assertions.includes(edge.id)),
      }
      const jobs = current.jobs.map((job): KnowledgeJob => {
        if (!sameKnowledgeScope(job.scope, scope)) return job
        if (job.source.id === id) return { ...job, stage: Option.none(), phase: { _tag: "Cancelled", cancelledAt: now } }
        if (!removed.sources.includes(job.source.id)) return { ...job, stage: Option.none() }
        return Option.exists(latest(current, scope, job.source.id), (source) => source.ref.revision === job.source.revision)
          ? { ...job, stage: Option.none(), phase: { _tag: "Queued" } } : { ...job, stage: Option.none() }
      })
      return Result.succeed({ state: { ...replaceScope(current, next), sources: current.sources.filter((source) => !sameKnowledgeScope(source.scope, scope) || source.ref.id !== id), jobs, tombstones: [...current.tombstones, { scope, id }] }, value: undefined })
    })),
    traverse: Effect.fn("knowledge_store.traverse")((query) => read((current) => traverseKnowledgeGraph(snapshotOf(scoped(current, query.scope)).graph, query))),
  }
  return index
})

/** Independent in-memory memory index, with its temporal graph view. @public */
export const MemoryStoreMemoryLive = Layer.effect(MemoryStore, makeKnowledgeIndexMemory())
/** Independent in-memory document index. @public */
export const KnowledgeStoreMemoryLive = Layer.effect(KnowledgeStore, makeKnowledgeIndexMemory())
/** Graph view of the configured memory index; document graphs use KnowledgeStore.traverse. @public */
export const TemporalGraphMemoryLive = Layer.effect(TemporalGraph, Effect.map(MemoryStore, (store) => ({ traverse: store.traverse })))
