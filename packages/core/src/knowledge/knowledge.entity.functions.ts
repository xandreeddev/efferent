import { Match, Option, Order } from "effect"
import {
  KnowledgeError,
  type KnowledgeAssertion, type KnowledgeCandidate, type KnowledgeCandidates, type KnowledgeEmbeddingSpace,
  type KnowledgeMemory, type KnowledgeScope, type KnowledgeSnapshot, type KnowledgeSource,
  type KnowledgeSourceRef, type KnowledgeStage, type KnowledgeSubgraph, type KnowledgeTraversal,
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
/** @public */
export const knowledgeCandidateText = (candidate: KnowledgeCandidate): string => Match.valueTags(candidate, {
  Memory: ({ memory }) => memory.text, Chunk: ({ chunk }) => chunk.text,
})
/** Reciprocal rank fusion with deterministic ties and one shared character budget. @public */
export const fuseKnowledgeCandidates = (arms: KnowledgeCandidates, limit: number, maxChars: number): ReadonlyArray<KnowledgeCandidate> => {
  const ranked = [...arms.lexical, ...arms.semantic].reduce((scores, candidate) => {
    const key = knowledgeCandidateKey(candidate)
    if (!scores.some((entry) => knowledgeCandidateKey(entry.candidate) === key)) {
      const lexical = arms.lexical.findIndex((item) => knowledgeCandidateKey(item) === key)
      const semantic = arms.semantic.findIndex((item) => knowledgeCandidateKey(item) === key)
      return [...scores, { candidate, score: (lexical < 0 ? 0 : 1 / (61 + lexical)) + (semantic < 0 ? 0 : 1 / (61 + semantic)) }]
    }
    return scores
  }, [] as ReadonlyArray<{ readonly candidate: KnowledgeCandidate; readonly score: number }>).toSorted((a, b) => b.score - a.score || Order.String(knowledgeCandidateKey(a.candidate), knowledgeCandidateKey(b.candidate)))
  return ranked.reduce((result, entry) => {
    const length = knowledgeCandidateText(entry.candidate).length
    return result.items.length < limit && result.used + length <= maxChars
      ? { used: result.used + length, items: [...result.items, { ...entry.candidate, score: entry.score }] }
      : result
  }, { used: 0, items: [] as ReadonlyArray<KnowledgeCandidate> }).items
}

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

/** Publication checks common to durable adapters. No extraction output is trusted as provenance. @public */
export const validateKnowledgeStage = (stage: KnowledgeStage, snapshot: KnowledgeSnapshot, sources: ReadonlyArray<KnowledgeSource>): Option.Option<KnowledgeError> => {
  const spans = [...stage.memories.flatMap((memory) => memory.provenance), ...stage.chunks.map((chunk) => chunk.provenance), ...stage.entities.flatMap((entity) => entity.provenance), ...stage.assertions.flatMap((edge) => edge.provenance)]
  const badSpan = spans.some((span) => span.start < 0 || span.end <= span.start || span.quote.length === 0 || !sources.some((source) => source.ref.id === span.source.id && source.ref.revision === span.source.revision && span.end <= source.text.length && source.text.slice(span.start, span.end) === span.quote))
  const ids = [...stage.memories.map((memory) => `memory:${memory.id}`), ...stage.chunks.map((chunk) => `chunk:${chunk.id}`), ...stage.entities.map((entity) => `entity:${entity.id}`), ...stage.assertions.map((edge) => `assertion:${edge.id}`)]
  const entityIds: ReadonlyArray<string> = [...snapshot.graph.entities.map((entity) => entity.id), ...stage.entities.map((entity) => entity.id)]
  const memoryIds = [...snapshot.memories.filter((memory) => Option.isNone(memory.knownTo) && !stage.retireMemories.includes(memory.id)).map((memory) => memory.id), ...stage.memories.map((memory) => memory.id)]
  const unknownEntity = stage.entities.some((entity) => entity.provenance.length === 0) || stage.assertions.some((edge) => endpoints(edge).some((id) => !entityIds.includes(id))) || stage.memories.some((memory) => memory.entities.some((id) => !entityIds.includes(id)))
  const unknownSupport = stage.memories.some((memory) => Match.valueTags(memory.evidence, {
    Stated: () => false, Inferred: ({ supports }) => supports.length === 0 || supports.some((id) => !memoryIds.includes(id) || id === memory.id),
  }))
  const allMemories = [...snapshot.memories.filter((memory) => Option.isNone(memory.knownTo) && !stage.retireMemories.includes(memory.id)), ...stage.memories]
  const cyclic = (id: string, seen: ReadonlyArray<string>): boolean => {
    if (seen.includes(id)) return true
    const memory = allMemories.find((item) => item.id === id)
    return memory ? Match.valueTags(memory.evidence, { Stated: () => false, Inferred: ({ supports }) => supports.some((support) => cyclic(support, [...seen, id])) }) : false
  }
  const unsupportedRoutine = stage.memories.some((memory) => memory.kind === "routine" && Match.valueTags(memory.evidence, {
    Stated: () => false,
    Inferred: ({ supports }) => new Set(supports.flatMap((id) => allMemories.find((item) => item.id === id)?.provenance.map((span) => {
      const episode = sources.find((source) => source.ref.id === span.source.id && source.ref.revision === span.source.revision)?.metadata.episode
      return typeof episode === "string" && episode.trim().length > 0 ? `episode:${episode}` : `source:${span.source.id}`
    }) ?? [])).size < 3,
  }))
  const retireMissing = stage.retireMemories.some((id) => !snapshot.memories.some((memory) => memory.id === id && Option.isNone(memory.knownTo))) ||
    stage.retireAssertions.some((id) => !snapshot.graph.assertions.some((edge) => edge.id === id && Option.isNone(edge.knownTo)))
  const intervalInvalid = (start: number, until: Option.Option<number>): boolean => !Number.isInteger(start) || start < 0 || Option.exists(until, (end) => !Number.isInteger(end) || end < start)
  const badInterval = stage.memories.some((memory) => intervalInvalid(memory.knownFrom, memory.knownTo)) || stage.assertions.some((edge) =>
    intervalInvalid(edge.knownFrom, edge.knownTo) || Option.match(edge.validFrom, {
      onNone: () => Option.exists(edge.validTo, (end) => !Number.isInteger(end) || end < 0),
      onSome: (from) => intervalInvalid(from, edge.validTo),
    }))
  const unsupportedProvenance = stage.memories.some((memory) => memory.provenance.length === 0) || stage.assertions.some((edge) => edge.provenance.length === 0)
  if (badSpan || badInterval || unsupportedProvenance || new Set(ids).size !== ids.length || unknownEntity || unknownSupport || unsupportedRoutine || stage.memories.some((memory) => cyclic(memory.id, []))) return Option.some(new KnowledgeError({ reason: "Invalid", message: "The staged index has invalid provenance, intervals, duplicate identities, or unsupported derivations" }))
  if (retireMissing) return Option.some(new KnowledgeError({ reason: "Conflict", message: "A retired record is no longer active" }))
  const vectors = stage.memories.flatMap((memory) => Option.toArray(memory.embedding)).concat(stage.chunks.flatMap((chunk) => Option.toArray(chunk.embedding)))
  const spaces = vectors.map((vector) => vector.space)
  const existing = snapshot.memories.flatMap((memory: KnowledgeMemory) => Option.isNone(memory.knownTo) ? Option.toArray(memory.embedding).map((vector) => vector.space) : [])
  const space = spaces[0] ?? existing[0]
  return space && [...spaces, ...existing].some((other) => !sameEmbeddingSpace(space, other))
    ? Option.some(new KnowledgeError({ reason: "EmbeddingMismatch", message: "Embedding identities cannot be mixed in one index scope" }))
    : Option.none()
}
