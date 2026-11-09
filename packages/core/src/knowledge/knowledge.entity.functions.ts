import { Match, Option, Order } from "effect"
import {
  KnowledgeError,
  type KnowledgeAssertion, type KnowledgeCandidate, type KnowledgeCandidates, type KnowledgeCorroboration, type KnowledgeEmbeddingSpace, type KnowledgeErrorReason, type KnowledgeJobFailure,
  type KnowledgeFailureDiagnostic, type KnowledgeFailureStep,
  type KnowledgeEventTime, type KnowledgeMemory, type KnowledgeMemoryKind, type KnowledgeProvenance, type KnowledgeRecallResult, type KnowledgeScope, type KnowledgeSnapshot, type KnowledgeSource,
  type KnowledgeSourceFilter, type KnowledgeSourceRef, type KnowledgeStage, type KnowledgeSubgraph, type KnowledgeTraversal, type KnowledgeMetadataFilter,
  type KnowledgeMetadataValue, type KnowledgeProfileMemory, type KnowledgeRecall, type KnowledgeSourceInfo, type KnowledgeSupport,
  type KnowledgeVector,
} from "./knowledge.entity.js"

/** Stable storage key; no delimiter ambiguity between isolation fields. @public */
export const knowledgeScopeKey = (scope: KnowledgeScope): string => JSON.stringify([scope.owner, scope.namespace, scope.collection])
/** @public */
export const knowledgeSourceKey = (scope: KnowledgeScope, source: KnowledgeSourceRef): string => JSON.stringify([knowledgeScopeKey(scope), source.id, source.revision])
/** @public */
export const sameKnowledgeScope = (left: KnowledgeScope, right: KnowledgeScope): boolean => knowledgeScopeKey(left) === knowledgeScopeKey(right)
/** @public */
export const sameEmbeddingSpace = (left: KnowledgeEmbeddingSpace, right: KnowledgeEmbeddingSpace): boolean =>
  left.model === right.model && left.version === right.version && left.dimensions === right.dimensions
const enginePart = (text: string): string => text.replaceAll("%", "%25").replaceAll("/", "%2F")
/**
 * The engine identity a processor records on its jobs: its name and version, then the embedding
 * space it indexes with (`rag:1/<model>/<version>/<dimensions>`). Distinct spaces always give
 * distinct ids, so workers of two embedding configurations never discover or claim each other's jobs.
 * @public
 */
export const knowledgeEngineId = (processor: string, space: KnowledgeEmbeddingSpace): string =>
  [processor, space.model, space.version].map(enginePart).concat(String(space.dimensions)).join("/")
/** Reasons no retry of the same source revision and configuration can change. */
const FINAL_REASONS: ReadonlyArray<KnowledgeErrorReason> = ["Invalid", "Tombstoned", "EmbeddingMismatch"]
/**
 * Whether retrying a failed job can succeed. A failure of the optional graph step can, whatever its
 * reason: the job's last attempt publishes without the graph. Otherwise an invalid source or output
 * (`Invalid`), a forgotten source (`Tombstoned`) or an incompatible embedding (`EmbeddingMismatch`)
 * cannot; every other reason is transient. The native engines retry a failed attempt by it within
 * `maxAttempts`; a host deciding whether to `retry` a failed job (its `Failed` phase) reads the same rule.
 * @public
 */
export const isRetryableKnowledgeFailure = (failure: Pick<KnowledgeJobFailure, "reason" | "step">): boolean =>
  failure.step === "Graph" || !FINAL_REASONS.includes(failure.reason)
/**
 * The failure an engine records with `KnowledgeIndex.fail` for an error at `step`: its reason and
 * message, and its `diagnostic` when it has one (an extraction that failed). @public
 */
export const knowledgeJobFailure = (error: KnowledgeError, step: KnowledgeFailureStep): KnowledgeJobFailure => ({
  reason: error.reason, message: error.message, step, ...(error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }),
})
/** A decode issue's path as JSONPath in bracket notation: `$` for the reply as a whole, `$["assertions"][0]["supersession"]` for a field. */
const jsonPathOf = (path: ReadonlyArray<string | number>): string =>
  `$${path.map((key) => typeof key === "number" ? `[${key}]` : `[${JSON.stringify(key)}]`).join("")}`
/**
 * The span attributes of an extraction failure's diagnostic, which the native engines set on the
 * current span when a job fails: `efferent.knowledge.failure.stage`, `….path` (JSONPath in bracket
 * notation, `$` for the reply as a whole), `….finish_reason`, `….output_tokens` and `….window`
 * (`part/parts`), each only when the diagnostic holds it. No content. @public
 */
export const knowledgeFailureAttributes = (diagnostic: KnowledgeFailureDiagnostic): Readonly<Record<string, string | number>> => ({
  "efferent.knowledge.failure.stage": diagnostic.stage,
  ...(diagnostic.path === undefined ? {} : { "efferent.knowledge.failure.path": jsonPathOf(diagnostic.path) }),
  ...(diagnostic.finishReason === undefined ? {} : { "efferent.knowledge.failure.finish_reason": diagnostic.finishReason }),
  ...(diagnostic.outputTokens === undefined ? {} : { "efferent.knowledge.failure.output_tokens": diagnostic.outputTokens }),
  ...(diagnostic.window === undefined ? {} : { "efferent.knowledge.failure.window": `${diagnostic.window.part}/${diagnostic.window.parts}` }),
})
/** Exact cosine, including a defined zero-norm score. @public */
export const knowledgeCosine = (left: KnowledgeVector, right: KnowledgeVector): number => {
  if (!sameEmbeddingSpace(left.space, right.space)) return 0
  const dot = left.values.reduce((sum, value, index) => sum + value * (right.values[index] ?? 0), 0)
  const norm = Math.sqrt(left.values.reduce((sum, value) => sum + value * value, 0) * right.values.reduce((sum, value) => sum + value * value, 0))
  return norm === 0 ? 0 : dot / norm
}
/** @public */
export const knowledgeTokens = (text: string): ReadonlyArray<string> => text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []
/** Native BM25 over a bounded corpus; exact IDs and names retain lexical evidence. @public */
export const knowledgeBm25 = (query: string, documents: ReadonlyArray<string>): ReadonlyArray<number> => {
  const terms = [...new Set(knowledgeTokens(query))]
  const corpus = documents.map(knowledgeTokens)
  const average = corpus.reduce((sum, words) => sum + words.length, 0) / Math.max(corpus.length, 1)
  return corpus.map((words) => terms.reduce((score, term) => {
    const frequency = words.filter((word) => word === term).length
    const containing = corpus.filter((tokens) => tokens.includes(term)).length
    const idf = Math.log(1 + (corpus.length - containing + 0.5) / (containing + 0.5))
    return frequency === 0 ? score : score + idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * words.length / Math.max(average, 1)))
  }, 0))
}
/** @public */
export const knowledgeCandidateKey = (candidate: KnowledgeCandidate): string => Match.valueTags(candidate, {
  Memory: ({ memory }) => `memory:${memory.id}`, Chunk: ({ chunk }) => `chunk:${chunk.id}`,
})
/** A relation's key beside the candidate keys: `assertion:<id>`, as `KnowledgeRecallHistory.successor` names a relation. @public */
export const knowledgeAssertionKey = (assertion: Pick<KnowledgeAssertion, "id">): string => `assertion:${assertion.id}`
/** @public */
export const knowledgeCandidateText = (candidate: KnowledgeCandidate): string => Match.valueTags(candidate, {
  Memory: ({ memory }) => memory.text, Chunk: ({ chunk }) => chunk.text,
})
/** One candidate and its fused score, between scoring and selection. */
interface ScoredKnowledgeCandidate { readonly candidate: KnowledgeCandidate; readonly key: string; readonly score: number }
/** Reciprocal rank fusion's constant: a candidate at 0-based rank `r` of a list scores `1 / (RRF_K + 1 + r)` there. */
const RRF_K = 60
/**
 * Score: every ranked list votes for each candidate it holds, `1 / (61 + rank)` at its 0-based rank in that list
 * alone, and a candidate's score is the sum of its votes. A candidate listed twice in one list keeps its first rank;
 * the candidate kept is its first occurrence over the lists, in their order.
 */
const scoreKnowledgeLists = (lists: ReadonlyArray<ReadonlyArray<KnowledgeCandidate>>): ReadonlyArray<ScoredKnowledgeCandidate> =>
  [...lists.reduce((scores, list) => {
    list.reduce((seen, candidate, rank) => {
      const key = knowledgeCandidateKey(candidate)
      if (seen.has(key)) return seen
      const vote = 1 / (RRF_K + 1 + rank)
      const scored = scores.get(key)
      scores.set(key, scored === undefined ? { candidate, key, score: vote } : { ...scored, score: scored.score + vote })
      return seen.add(key)
    }, new Set<string>())
    return scores
  }, new Map<string, ScoredKnowledgeCandidate>()).values()]
/** Sort: the highest score first, ties by candidate key. */
const byKnowledgeScore = (scored: ReadonlyArray<ScoredKnowledgeCandidate>): ReadonlyArray<ScoredKnowledgeCandidate> =>
  scored.toSorted((a, b) => b.score - a.score || Order.String(a.key, b.key))
/** Select: in order, each candidate that still fits `limit` and the shared character budget, carrying its fused score. */
const selectKnowledgeCandidates = (ranked: ReadonlyArray<ScoredKnowledgeCandidate>, limit: number, maxChars: number): ReadonlyArray<KnowledgeCandidate> =>
  ranked.reduce((result, entry) => {
    const length = knowledgeCandidateText(entry.candidate).length
    return result.items.length < limit && result.used + length <= maxChars
      ? { used: result.used + length, items: [...result.items, { ...entry.candidate, score: entry.score }] }
      : result
  }, { used: 0, items: [] as ReadonlyArray<KnowledgeCandidate> }).items
/** Weight: each fused score times the candidate's weight, before sorting. */
const weighKnowledgeCandidates = (scored: ReadonlyArray<ScoredKnowledgeCandidate>, weight: (candidate: KnowledgeCandidate) => number): ReadonlyArray<ScoredKnowledgeCandidate> =>
  scored.map((entry) => ({ ...entry, score: entry.score * weight(entry.candidate) }))
/**
 * Reciprocal rank fusion with deterministic ties and one shared character budget. Takes one search's lexical and
 * semantic lists, or one such pair per query of a planned search: every list is ranked on its own, so a candidate
 * a later query finds first scores as highly as one the first query finds first, and a candidate several lists
 * find sums its votes, `1 / (61 + rank)` per list at its 0-based rank there. With `weight`, each candidate's fused
 * score is multiplied by its weight (the candidate as the lists first hold it) before ranking; without it, or with
 * a weight of 1 for every candidate, the ranking is plain fusion. Ties go by candidate key; `limit` and `maxChars`
 * select from the ranked result, and each selected candidate carries its final score.
 * @public
 */
export const fuseKnowledgeCandidates = (
  arms: KnowledgeCandidates | ReadonlyArray<KnowledgeCandidates>, limit: number, maxChars: number, weight?: (candidate: KnowledgeCandidate) => number,
): ReadonlyArray<KnowledgeCandidate> => {
  const pairs: ReadonlyArray<KnowledgeCandidates> = "lexical" in arms ? [arms] : arms
  const scored = scoreKnowledgeLists(pairs.flatMap((pair) => [pair.lexical, pair.semantic]))
  return selectKnowledgeCandidates(byKnowledgeScore(weight === undefined ? scored : weighKnowledgeCandidates(scored, weight)), limit, maxChars)
}

const sameKnowledgeRevision = (left: KnowledgeSourceRef, right: KnowledgeSourceRef): boolean => left.id === right.id && left.revision === right.revision
const distinctRevisions = (refs: ReadonlyArray<KnowledgeSourceRef>): ReadonlyArray<KnowledgeSourceRef> =>
  refs.filter((ref, index) => refs.findIndex((other) => sameKnowledgeRevision(other, ref)) === index)
/**
 * The source revisions whose own text states a memory, once each: its `mentions`, or, for a memory
 * stored before they existed, the revision its first span cites when it is stated (staging puts a
 * record's own spans first) and every revision its provenance cites when it is inferred.
 * @public
 */
export const knowledgeMemoryMentions = (memory: Pick<KnowledgeMemory, "mentions" | "provenance" | "evidence">): ReadonlyArray<KnowledgeSourceRef> =>
  distinctRevisions(memory.mentions ?? Match.valueTags(memory.evidence, {
    Stated: () => memory.provenance.slice(0, 1).map((span) => span.source),
    Inferred: () => memory.provenance.map((span) => span.source),
  }))
const sameKnowledgeSpan = (left: KnowledgeProvenance, right: KnowledgeProvenance): boolean =>
  sameKnowledgeRevision(left.source, right.source) && left.start === right.start && left.end === right.end && left.quote === right.quote
const distinctSpans = (spans: ReadonlyArray<KnowledgeProvenance>): ReadonlyArray<KnowledgeProvenance> =>
  spans.filter((span, index) => spans.findIndex((other) => sameKnowledgeSpan(other, span)) === index)
/** Corroborations of one memory by one revision as one, their spans once each, in first-seen order. */
export const mergeKnowledgeCorroborations = (corroborations: ReadonlyArray<KnowledgeCorroboration>): ReadonlyArray<KnowledgeCorroboration> =>
  corroborations.reduce<ReadonlyArray<KnowledgeCorroboration>>((merged, next) => {
    const same = (prior: KnowledgeCorroboration) => prior.memory === next.memory && sameKnowledgeRevision(prior.mention, next.mention)
    return merged.some(same)
      ? merged.map((prior) => same(prior) ? { ...prior, provenance: distinctSpans([...prior.provenance, ...next.provenance]) } : prior)
      : [...merged, { ...next, provenance: distinctSpans(next.provenance) }]
  }, [])
/**
 * A memory with a corroboration's evidence (`KnowledgeCorroboration`): its spans appended to the
 * provenance and its revision to the mentions, each once. A memory stored before `mentions` existed
 * gains them, starting with those its provenance gave it (`knowledgeMemoryMentions`). Stores apply it
 * at publication.
 * @public
 */
export const corroborateKnowledgeMemory = (memory: KnowledgeMemory, corroboration: KnowledgeCorroboration): KnowledgeMemory => ({
  ...memory,
  provenance: distinctSpans([...memory.provenance, ...corroboration.provenance]),
  mentions: distinctRevisions([...knowledgeMemoryMentions(memory), corroboration.mention]),
})
/**
 * A memory another source published, once `source` (the revision being published) replaces its
 * earlier revisions: without their spans and mentions, which a corroboration of those revisions
 * (or the evidence of an entity they defined) put there. None when nothing would be left of its
 * provenance or of the mentions it has; a store then retires the memory. Stores apply it at
 * publication to the active memories the publishing source did not publish.
 * @public
 */
export const stripKnowledgeRevisions = (memory: KnowledgeMemory, source: KnowledgeSourceRef): Option.Option<KnowledgeMemory> => {
  const stale = (ref: KnowledgeSourceRef) => ref.id === source.id && ref.revision !== source.revision
  const provenance = memory.provenance.filter((span) => !stale(span.source))
  const mentions = memory.mentions?.filter((ref) => !stale(ref))
  return provenance.length === 0 || mentions?.length === 0 ? Option.none() : Option.some({ ...memory, provenance, ...(mentions === undefined ? {} : { mentions }) })
}
/**
 * The episode a source revision belongs to, as `knowledgeEpisodeCount` tells episodes apart: the
 * nonblank `metadata.episode` its info in `infos` names, else the source itself.
 */
const knowledgeEpisodeKey = (ref: KnowledgeSourceRef, infos: ReadonlyArray<Pick<KnowledgeSourceInfo, "ref" | "metadata">>): string => {
  const episode = infos.find((info) => sameKnowledgeRevision(info.ref, ref))?.metadata.episode
  return typeof episode === "string" && episode.trim().length > 0 ? `episode:${episode}` : `source:${ref.id}`
}
/**
 * How many distinct episodes the revisions belong to: revisions whose info in `infos` names the same
 * nonblank `metadata.episode` are one episode, and a revision whose info names none, or is missing,
 * is an episode of its source. The routine rule (`validateKnowledgeStage`, `stageKnowledgeExtraction`)
 * and `knowledgeMemorySupport` count by it.
 */
export const knowledgeEpisodeCount = (refs: ReadonlyArray<KnowledgeSourceRef>, infos: ReadonlyArray<Pick<KnowledgeSourceInfo, "ref" | "metadata">>): number =>
  new Set(refs.map((ref) => knowledgeEpisodeKey(ref, infos))).size
/** The kinds that hold only until the dated event they concern: a plan, goal, decision or interest tied to it. */
const EVENT_BOUND_KINDS: ReadonlyArray<KnowledgeMemoryKind> = ["goal", "decision", "action", "preference"]
/**
 * Whether a memory is past at `now`: it is a goal, decision, action or preference whose dated event
 * (`KnowledgeMemory.eventAt`) ended before `now`, at its `end`, else its `start`. A memory without an
 * event, and a fact, routine or profile whatever its event, is never past. Being past demotes a record
 * in recall and leaves it out of the profile; nothing deletes or filters it from search.
 * @public
 */
export const knowledgeMemoryIsPast = (memory: Pick<KnowledgeMemory, "kind" | "eventAt">, now: number): boolean =>
  memory.eventAt !== undefined && EVENT_BOUND_KINDS.includes(memory.kind) && (memory.eventAt.end ?? memory.eventAt.start) < now
/** Whether two records concern the same event time: both none, or the same start and end. */
export const sameKnowledgeEventTime = (left: KnowledgeEventTime | undefined, right: KnowledgeEventTime | undefined): boolean =>
  left === undefined || right === undefined ? left === right : left.start === right.start && left.end === right.end
/**
 * How often a memory was stated, from the info of the revisions it mentions (`knowledgeMemoryMentions`;
 * pass `KnowledgeIndex.sourceInfo` of them, or a recall result's `sources`): only revisions found in
 * `infos` count, so a forgotten one never does, and the evidence of the memory's entities is never a
 * mention. Episodes are counted as `knowledgeEpisodeCount` does among those live revisions. None when
 * no mentioned revision is found.
 * @public
 */
export const knowledgeMemorySupport = (memory: Pick<KnowledgeMemory, "mentions" | "provenance" | "evidence">, infos: ReadonlyArray<Pick<KnowledgeSourceInfo, "ref" | "occurredAt" | "metadata">>): Option.Option<KnowledgeSupport> => {
  const live = knowledgeMemoryMentions(memory).flatMap((ref) => infos.filter((info) => sameKnowledgeRevision(info.ref, ref)).slice(0, 1))
  const times = live.map((info) => info.occurredAt)
  return live.length === 0 ? Option.none() : Option.some({
    episodes: knowledgeEpisodeCount(live.map((info) => info.ref), live), sources: live.length, firstSeen: Math.min(...times), lastSeen: Math.max(...times),
  })
}

/**
 * The order of a memory profile (`LongTermMemory.profile`): the memory stated in more episodes first
 * (`KnowledgeSupport.episodes`), then the one stated more recently (`lastSeen`), then by id. A memory
 * without `support` follows every one with it, by id. The store's own order (insertion, or id, where
 * ids begin with their source's) never decides it, so the same memories give the same profile on
 * every store.
 * @public
 */
export const knowledgeProfileOrder: Order.Order<KnowledgeProfileMemory> = Order.combineAll([
  Order.mapInput(Order.flip(Order.Number), (memory: KnowledgeProfileMemory) => memory.support?.episodes ?? 0),
  Order.mapInput(Order.flip(Order.Number), (memory: KnowledgeProfileMemory) => memory.support?.lastSeen ?? -1),
  Order.mapInput(Order.String, (memory: KnowledgeProfileMemory) => memory.id),
])

/**
 * The source revisions a recall's evidence cites, once each, in order of first citation:
 * candidates, then relations, then entities, then earlier states. Engines read their info for
 * `KnowledgeRecallResult.sources`.
 * @public
 */
export const citedKnowledgeSources = (evidence: Pick<KnowledgeRecallResult, "candidates" | "graph"> & { readonly history?: KnowledgeRecallResult["history"] }): ReadonlyArray<KnowledgeSourceRef> => {
  const spans = [
    ...evidence.candidates.flatMap((candidate) => Match.valueTags(candidate, { Memory: ({ memory }) => memory.provenance, Chunk: ({ chunk }) => [chunk.provenance] })),
    ...evidence.graph.assertions.flatMap((assertion) => assertion.provenance),
    ...evidence.graph.entities.flatMap((entity) => entity.provenance),
    ...(evidence.history ?? []).flatMap((earlier) => earlier.record.provenance),
  ]
  return [...new Map(spans.map((span) => [JSON.stringify([span.source.id, span.source.revision]), span.source] as const)).values()]
}
/**
 * When a record was said or written: the occurrence time of the source revision its first span
 * cites, read from `sources` (a recall result's `sources`, or `KnowledgeIndex.sourceInfo`); none
 * when that revision is not among them, as for a forgotten source or a result encoded before
 * `sources` existed. `stageKnowledgeExtraction` puts a record's own spans first, before the
 * evidence of its entities and of the memories it is inferred from, and a relation's history copy
 * keeps the earlier relation's spans first, so the first span is where the record was stated.
 * @public
 */
export const knowledgeRecordDate = (provenance: ReadonlyArray<KnowledgeProvenance>, sources: ReadonlyArray<Pick<KnowledgeSourceInfo, "ref" | "occurredAt">>): Option.Option<number> =>
  Option.fromNullishOr(provenance[0]).pipe(
    Option.flatMap((first) => Option.fromNullishOr(sources.find((info) => info.ref.id === first.source.id && info.ref.revision === first.source.revision))),
    Option.map((info) => info.occurredAt),
  )

const atTime = (start: number, end: Option.Option<number>, time: number): boolean => start <= time && Option.match(end, { onNone: () => true, onSome: (until) => time < until })
const validEdge = (edge: KnowledgeAssertion, query: KnowledgeTraversal): boolean =>
  atTime(edge.knownFrom, edge.knownTo, query.perspective.knownAt) &&
  Option.match(edge.validFrom, { onNone: () => true, onSome: (from) => from <= query.perspective.validAt }) &&
  Option.match(edge.validTo, { onNone: () => true, onSome: (until) => query.perspective.validAt < until })
const endpoints = (edge: KnowledgeAssertion): ReadonlyArray<string> => Match.valueTags(edge.object, {
  Entity: ({ entityId }) => [edge.subject, entityId], Value: () => [edge.subject],
})
/** Bounded breadth-first traversal with both temporal coordinates applied at every hop. @public */
export const traverseKnowledgeGraph = (graph: KnowledgeSubgraph, query: KnowledgeTraversal): KnowledgeSubgraph => {
  const eligible = graph.assertions.filter((edge) => validEdge(edge, query))
  const visit = (frontier: ReadonlyArray<string>, seen: ReadonlyArray<string>, edges: ReadonlyArray<KnowledgeAssertion>, depth: number): { readonly entities: ReadonlyArray<string>; readonly assertions: ReadonlyArray<KnowledgeAssertion>; readonly truncated: boolean } => {
    if (depth === 0 || frontier.length === 0) return { entities: seen, assertions: edges, truncated: false }
    const adjacent = eligible.filter((edge) => !edges.some((prior) => prior.id === edge.id) && endpoints(edge).some((id) => frontier.includes(id)))
      .toSorted((a, b) => Order.String(a.id, b.id))
    const selected = adjacent.slice(0, Math.max(0, query.limit - edges.length))
    const discovered = [...new Set(selected.flatMap(endpoints))].filter((id) => !seen.includes(id))
    const retained = discovered.slice(0, Math.max(0, query.limit - seen.length))
    const next = visit(retained, [...seen, ...retained], [...edges, ...selected], depth - 1)
    return { ...next, truncated: next.truncated || adjacent.length > selected.length || discovered.length > retained.length }
  }
  const seeds = [...new Set(query.seeds)].slice(0, query.limit)
  const result = visit(seeds, seeds, [], Math.min(query.depth, 3))
  const entities = graph.entities.filter((entity) => result.entities.includes(entity.id))
  const ids: ReadonlyArray<string> = entities.map((entity) => entity.id)
  return {
    entities,
    assertions: result.assertions.filter((edge) => endpoints(edge).every((id) => ids.includes(id))),
    truncated: result.truncated || query.seeds.length > seeds.length || result.assertions.some((edge) => endpoints(edge).some((id) => !ids.includes(id))),
  }
}

/** Whether every span of a record's provenance cites one of the listed sources. @public */
export const citesKnowledgeSources = (provenance: ReadonlyArray<KnowledgeProvenance>, sources: KnowledgeSourceFilter): boolean =>
  provenance.length > 0 && provenance.every((span) => sources.includes(span.source.id))
/** Whether every span of a record's provenance cites a revision the predicate admits (`knowledgeNarrowingAdmits`). @public */
export const citesAdmittedKnowledge = (provenance: ReadonlyArray<KnowledgeProvenance>, admits: (ref: KnowledgeSourceRef) => boolean): boolean =>
  provenance.length > 0 && provenance.every((span) => admits(span.source))
/**
 * A memory as a narrowed read shows it (`knowledgeNarrowingAdmits`): none unless every span of its
 * own evidence cites an admitted revision. The revisions that restated a stated memory after it was
 * published (`KnowledgeCorroboration`: its mentions after the first) are no part of that evidence: their
 * spans and mentions stay where admitted and are left out elsewhere, so a restatement outside the
 * reach neither hides the memory from it nor shows there.
 * @public
 */
export const narrowKnowledgeMemory = <M extends KnowledgeMemory>(memory: M, admits: (ref: KnowledgeSourceRef) => boolean): Option.Option<M> => {
  const later = memory.evidence._tag === "Stated" && memory.mentions !== undefined ? knowledgeMemoryMentions(memory).slice(1) : []
  const among = (refs: ReadonlyArray<KnowledgeSourceRef>) => (ref: KnowledgeSourceRef) => refs.some((other) => sameKnowledgeRevision(other, ref))
  if (!citesAdmittedKnowledge(memory.provenance.filter((span) => !among(later)(span.source)), admits)) return Option.none()
  const hidden = later.filter((ref) => !admits(ref))
  return Option.some(hidden.length === 0 ? memory : {
    ...memory, provenance: memory.provenance.filter((span) => !among(hidden)(span.source)), mentions: knowledgeMemoryMentions(memory).filter((ref) => !among(hidden)(ref)),
  })
}
/** A candidate as a narrowed read shows it: a chunk whose revision is admitted, a memory as `narrowKnowledgeMemory` narrows it. */
export const narrowKnowledgeCandidate = (candidate: KnowledgeCandidate, admits: (ref: KnowledgeSourceRef) => boolean): Option.Option<KnowledgeCandidate> => Match.valueTags(candidate, {
  Memory: (value) => Option.map(narrowKnowledgeMemory(value.memory, admits), (memory): KnowledgeCandidate => ({ ...value, memory })),
  Chunk: (value) => citesAdmittedKnowledge([value.chunk.provenance], admits) ? Option.some(value) : Option.none(),
})
/** Whether a candidate is evidence from the listed sources (`KnowledgeSearch.sources`), as `narrowKnowledgeCandidate` admits it. */
export const knowledgeCandidateWithin = (candidate: KnowledgeCandidate, sources: KnowledgeSourceFilter): boolean =>
  Option.isSome(narrowKnowledgeCandidate(candidate, (ref) => sources.includes(ref.id)))
/** Whether a candidate is evidence from admitted revisions (`knowledgeNarrowingAdmits`), as `narrowKnowledgeCandidate` admits it. */
export const knowledgeCandidateAdmitted = (candidate: KnowledgeCandidate, admits: (ref: KnowledgeSourceRef) => boolean): boolean =>
  Option.isSome(narrowKnowledgeCandidate(candidate, admits))
/**
 * Whether a source revision's metadata matches a filter (`KnowledgeMetadataFilter`): every key
 * holds, at the top level, a value equal to the key's scalar or to one of its alternatives.
 * @public
 */
export const matchesKnowledgeMetadata = (metadata: KnowledgeSource["metadata"], filter: KnowledgeMetadataFilter): boolean =>
  Object.entries(filter).every(([key, expected]) => {
    const alternatives: ReadonlyArray<KnowledgeMetadataValue> = Array.isArray(expected) ? expected : [expected]
    const value = metadata[key]
    return Object.hasOwn(metadata, key) && alternatives.some((alternative) => alternative === value)
  })
/**
 * A read's narrowing as a predicate on the revisions its evidence cites: listed in its `sources`,
 * when given, and, when it has a `metadata` filter, one of `infos` whose metadata matches. Pass
 * the info of the revisions the evidence cites (`KnowledgeIndex.sourceInfo`); a revision missing
 * from it, as a forgotten one is, matches no metadata filter.
 * @public
 */
export const knowledgeNarrowingAdmits = (narrowing: Pick<KnowledgeRecall, "sources" | "metadata">, infos: ReadonlyArray<Pick<KnowledgeSourceInfo, "ref" | "metadata">>): (ref: KnowledgeSourceRef) => boolean => {
  const { sources, metadata } = narrowing
  return (ref) => (sources === undefined || sources.includes(ref.id)) &&
    (metadata === undefined || infos.some((info) => info.ref.id === ref.id && info.ref.revision === ref.revision && matchesKnowledgeMetadata(info.metadata, metadata)))
}
/** Whether one source revision is within a read's narrowing (`KnowledgeRecall.sources` and `.metadata`: both must hold). @public */
export const admitsKnowledgeSource = (narrowing: Pick<KnowledgeRecall, "sources" | "metadata">, source: Pick<KnowledgeSourceInfo, "ref" | "metadata">): boolean =>
  knowledgeNarrowingAdmits(narrowing, [source])(source.ref)
/**
 * The part of a graph the listed sources support: an entity they mention, keeping only its spans
 * in them, and an assertion every span of which cites them, between entities that remain.
 * @public
 */
export const narrowKnowledgeGraph = (graph: KnowledgeSubgraph, sources: KnowledgeSourceFilter): KnowledgeSubgraph =>
  narrowKnowledgeGraphBy(graph, (ref) => sources.includes(ref.id))
/**
 * The part of a graph the admitted revisions support (`knowledgeNarrowingAdmits`): an entity
 * they mention, keeping only its spans in them, and an assertion every span of which cites
 * them, between entities that remain.
 * @public
 */
export const narrowKnowledgeGraphBy = (graph: KnowledgeSubgraph, admits: (ref: KnowledgeSourceRef) => boolean): KnowledgeSubgraph => {
  const entities = graph.entities.flatMap((entity) => {
    const provenance = entity.provenance.filter((span) => admits(span.source))
    return provenance.length === 0 ? [] : [{ ...entity, provenance }]
  })
  const kept: ReadonlyArray<string> = entities.map((entity) => entity.id)
  return {
    entities,
    assertions: graph.assertions.filter((edge) => citesAdmittedKnowledge(edge.provenance, admits) && endpoints(edge).every((id) => kept.includes(id))),
    truncated: graph.truncated,
  }
}

/**
 * Publication checks common to durable adapters. No extraction output is trusted as provenance; a
 * memory's `mentions` must be revisions its provenance cites. A corroboration's spans must cite its
 * own revision and its memory must be a stated memory of the snapshot (`Invalid` otherwise), still
 * active and not retired by the stage (`Conflict` otherwise).
 * @public
 */
export const validateKnowledgeStage = (stage: KnowledgeStage, snapshot: KnowledgeSnapshot, sources: ReadonlyArray<KnowledgeSource>): Option.Option<KnowledgeError> => {
  const corroborations = stage.corroborations ?? []
  const spans = [...stage.memories.flatMap((memory) => memory.provenance), ...stage.chunks.map((chunk) => chunk.provenance), ...stage.entities.flatMap((entity) => entity.provenance), ...stage.assertions.flatMap((edge) => edge.provenance), ...corroborations.flatMap((corroboration) => corroboration.provenance)]
  const badSpan = spans.some((span) => span.start < 0 || span.end <= span.start || span.quote.length === 0 || !sources.some((source) => source.ref.id === span.source.id && source.ref.revision === span.source.revision && span.end <= source.text.length && source.text.slice(span.start, span.end) === span.quote))
  const ids = [...stage.memories.map((memory) => `memory:${memory.id}`), ...stage.chunks.map((chunk) => `chunk:${chunk.id}`), ...stage.entities.map((entity) => `entity:${entity.id}`), ...stage.assertions.map((edge) => `assertion:${edge.id}`)]
  const entityIds: ReadonlyArray<string> = [...snapshot.graph.entities.map((entity) => entity.id), ...stage.entities.map((entity) => entity.id)]
  const memoryIds = new Set([...snapshot.memories.filter((memory) => Option.isNone(memory.knownTo) && !stage.retireMemories.includes(memory.id)).map((memory) => memory.id), ...stage.memories.map((memory) => memory.id)])
  const unknownEntity = stage.entities.some((entity) => entity.provenance.length === 0) || stage.assertions.some((edge) => endpoints(edge).some((id) => !entityIds.includes(id))) || stage.memories.some((memory) => memory.entities.some((id) => !entityIds.includes(id)))
  const unknownSupport = stage.memories.some((memory) => Match.valueTags(memory.evidence, {
    Stated: () => false, Inferred: ({ supports }) => supports.length === 0 || supports.some((id) => !memoryIds.has(id) || id === memory.id),
  }))
  const allMemories = [...snapshot.memories.filter((memory) => Option.isNone(memory.knownTo) && !stage.retireMemories.includes(memory.id)), ...stage.memories]
  const memoryById = new Map(allMemories.map((memory) => [String(memory.id), memory]))
  const remaining = new Map<string, number>()
  const dependents = new Map<string, Array<string>>()
  for (const memory of allMemories) {
    const supports = Match.valueTags(memory.evidence, { Stated: () => [], Inferred: (value) => value.supports })
    remaining.set(memory.id, supports.length)
    for (const support of supports) {
      const children = dependents.get(support)
      if (children) children.push(memory.id)
      else dependents.set(support, [memory.id])
    }
  }
  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id)
  for (let at = 0; at < ready.length; at++) {
    for (const dependent of dependents.get(ready[at]!) ?? []) {
      const count = remaining.get(dependent)! - 1
      remaining.set(dependent, count)
      if (count === 0) ready.push(dependent)
    }
  }
  const cyclic = ready.length !== memoryById.size
  const unsupportedRoutine = stage.memories.some((memory) => memory.kind === "routine" && Match.valueTags(memory.evidence, {
    Stated: () => false,
    Inferred: ({ supports }) => knowledgeEpisodeCount(supports.flatMap((id) => Option.match(Option.fromNullishOr(memoryById.get(id)), { onNone: () => [], onSome: knowledgeMemoryMentions })), sources) < 3,
  }))
  // A memory mentions only revisions its provenance cites, so forgetting any of them removes it with the rest of its evidence.
  const strayMention = stage.memories.some((memory) => (memory.mentions ?? []).some((ref) => !memory.provenance.some((span) => sameKnowledgeRevision(span.source, ref))))
  // A corroboration's spans are its revision's own, and it evidences a stated memory: a restatement of an inference is no restatement.
  const corroborated = (id: string) => snapshot.memories.find((memory) => memory.id === id)
  const strayCorroboration = corroborations.some((corroboration) => corroboration.provenance.some((span) => !sameKnowledgeRevision(span.source, corroboration.mention)) ||
    corroborated(corroboration.memory)?.evidence._tag === "Inferred" || stage.memories.some((memory) => memory.id === corroboration.memory))
  const corroborationInactive = corroborations.some((corroboration) => stage.retireMemories.includes(corroboration.memory) ||
    !Option.exists(Option.fromNullishOr(corroborated(corroboration.memory)), (memory) => Option.isNone(memory.knownTo)))
  const retireMissing = stage.retireMemories.some((id) => !snapshot.memories.some((memory) => memory.id === id && Option.isNone(memory.knownTo))) ||
    stage.retireAssertions.some((id) => !snapshot.graph.assertions.some((edge) => edge.id === id && Option.isNone(edge.knownTo)))
  const intervalInvalid = (start: number, until: Option.Option<number>): boolean => !Number.isInteger(start) || start < 0 || Option.exists(until, (end) => !Number.isInteger(end) || end < start)
  const badInterval = stage.memories.some((memory) => intervalInvalid(memory.knownFrom, memory.knownTo)) || stage.assertions.some((edge) =>
    intervalInvalid(edge.knownFrom, edge.knownTo) || Option.match(edge.validFrom, {
      onNone: () => Option.exists(edge.validTo, (end) => !Number.isInteger(end) || end < 0),
      onSome: (from) => intervalInvalid(from, edge.validTo),
    }))
  const unsupportedProvenance = stage.memories.some((memory) => memory.provenance.length === 0) || stage.assertions.some((edge) => edge.provenance.length === 0)
  if (badSpan || badInterval || unsupportedProvenance || strayMention || strayCorroboration || new Set(ids).size !== ids.length || unknownEntity || unknownSupport || unsupportedRoutine || cyclic) return Option.some(new KnowledgeError({ reason: "Invalid", message: "The staged index has invalid provenance, mentions, corroborations, intervals, duplicate identities, or unsupported derivations" }))
  if (retireMissing) return Option.some(new KnowledgeError({ reason: "Conflict", message: "A retired record is no longer active" }))
  if (corroborationInactive) return Option.some(new KnowledgeError({ reason: "Conflict", message: "A corroborated memory is no longer active" }))
  const vectors = stage.memories.flatMap((memory) => Option.toArray(memory.embedding)).concat(stage.chunks.flatMap((chunk) => Option.toArray(chunk.embedding)))
  const spaces = vectors.map((vector) => vector.space)
  const existing = snapshot.memories.flatMap((memory: KnowledgeMemory) => Option.isNone(memory.knownTo) ? Option.toArray(memory.embedding).map((vector) => vector.space) : [])
  const space = spaces[0] ?? existing[0]
  return space && [...spaces, ...existing].some((other) => !sameEmbeddingSpace(space, other))
    ? Option.some(new KnowledgeError({ reason: "EmbeddingMismatch", message: "Embedding identities cannot be mixed in one index scope" }))
    : Option.none()
}
