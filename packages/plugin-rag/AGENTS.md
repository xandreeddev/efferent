# @xandreed/plugin-rag

Efferent's native document engine: exact source spans, staged chunking and
embedding, hybrid retrieval, cited reads and optional temporal GraphRAG.
Production imports core only; PostgreSQL persistence is provided separately
through KnowledgeStore. Node 24 and Bun.

## Rules

- Keep personal memory separate: document extraction returns no memories.
- Every operation names owner, namespace and collection. Model tools and the
  recall section take owner and any source or metadata filter from the run's
  `KnowledgeNarrowing` (by default `RunContext.session.owner`, no filter); they
  accept no owner, source or metadata parameter, and a source revision read
  outside the filters is not found. Retrieval passes both filters to
  `KnowledgeStore.search`, which applies them before its limit, and narrows the
  graph by the metadata of the revisions it cites.
- Ingestion enqueues immutable source revisions. Do not replace the published
  document until all chunks, vectors and graph extraction are staged and the
  store accepts the lease, source revision and scope CAS atomically.
- The graph is optional, the chunks are not. A failed or invalid graph
  extraction or review fails the attempt with `RagGraphFailed`, recorded on
  the job with step `Graph` and retried within `maxAttempts` whatever its
  reason; the last attempt stages the chunks without the graph and a
  `GraphOmitted` stage note. A graph record staging leaves out for a failure
  of its own is no graph failure: its `RecordDropped` notes stay on the stage
  beside the chunks and the rest of the graph. Every other failure is recorded with step
  `Required`; whether it is retried is `isRetryableKnowledgeFailure` (core),
  the rule hosts share, never a local reason check.
- Chunk text and provenance are exact UTF-16 slices of the original source.
  Prefer paragraph, heading and line boundaries; never normalize source text.
- Plain RAG requires KnowledgeStore and EmbeddingModel. Graph extraction is
  opt-in and requires UtilityLlm; extracted entity identities and evidence
  are validated by core before publication. Review is enabled by default.
  Extraction runs through core's `extractKnowledge`: one call (and one
  review) per `maxExtractionChars` window, merged before staging; it decodes
  each helper completion. A failed job is recorded with `knowledgeJobFailure`,
  which keeps an extraction's diagnostic, set on the span with
  `knowledgeFailureAttributes`.
- Every UtilityLlm call runs inside `CurrentKnowledgeHelperCall` (purpose,
  scope, job and attempt for extraction and review, `maxHelperOutputTokens`).
  The cap is advisory: only a host's own UtilityLlm that reads the reference
  applies it; the models plugin's `UtilityLlmLive` does not.
- Query planning and reranking are opt-in (`queryPlanning`, `rerank`, both
  false by default: each costs a helper call per search) and use the
  optional UtilityLlm with a separate bound. Invalid or unavailable assistance keeps hybrid evidence; a reranker
  cannot introduce a candidate identity. Explicit traversal coordinates win.
- Keep the original query in the bounded search plan. Combine lexical and
  semantic arms with core's deterministic reciprocal rank fusion, one pair
  per query (`fuseKnowledgeCandidates`), never one joined list. A
  `minSimilarity` (absent by default) goes to the store as the semantic arm's
  floor (`KnowledgeSearch.minSimilarity`); passages are never collapsed. Graph
  expansion applies both temporal coordinates at every hop and shares the
  evidence budget with excerpts.
- Renew processing leases throughout model and embedding work. Serialize
  local processing, coordinate stop with claiming, and count admitted claims
  and claimed work in BackgroundWorkers. Keep masked claim I/O outside the
  admission permit so shutdown can cancel it and report it as busy. Pending
  jobs and sleeping pollers are idle.
- The engine id derives from the embedding options (`knowledgeEngineId`):
  enqueue, discover and claim only under it, never a constant.
- The engine's own retries within `maxAttempts` use the store's `retry`
  (engine and attempts kept). The service's `retry` is the host's: it checks
  the scope is the engine's collection and calls the store's `requeue` with
  the engine id, resetting attempts and taking over a job failed under an
  older id.
- A stopped worker accepts durable ingestion but starts no new work. Scope
  closure interrupts its fiber before its store dependency closes. A failed
  job retains its staged chunks; another worker of the same engine id can
  resume from them after retry.
- Tools are read-only. Optional recall is a turn-tier recorded section;
  retrieved text never enters the stable system prefix.

## Public surface

ragPlugin (also default), RagPluginLive, RagLive, RagConfig and ragDefaults;
knowledgeEvidenceText and knowledgeSourcePage, the evidence and source-page
text the tools show, for a host's own tools.
The main plugin provides Knowledge and contributes Capabilities and
BackgroundWorkers. It requires KnowledgeStore and EmbeddingModel; UtilityLlm
is optional unless graph extraction is enabled.

## Model-facing text

Core owns and pins shared extraction, review, query planning and reranking
prompts. This package owns the following text contracts:

| Text | Source | Pinned by |
|---|---|---|
| Tool descriptions, parameter descriptions, skill summary and failure messages | `src/rag-capability.adapter.ts:12` | exact, `src/rag-capability.adapter.test.ts:11` |
| Retrieved evidence and turn-section rendering | `src/rag.entity.functions.ts:33` | exact, `src/rag-capability.adapter.test.ts:33` |
| Traversal result-limit note | `src/rag.entity.functions.ts:42` | exact, `src/rag-capability.adapter.test.ts:34` |
| Source page framing and continuation | `src/rag.entity.functions.ts:51` | exact, `src/rag-capability.adapter.test.ts:35`; exact, `src/rag-capability.adapter.test.ts:36` |

## Tests

- `src/rag-engine.adapter.test.ts`: exact chunk spans, Unicode, source
  replacement failure/retry, worker restart, owner isolation, forgetting,
  temporal two-hop GraphRAG, document/personal-memory separation, windowed
  graph extraction with exact provenance, helper call contexts, graph
  extraction retried within `maxAttempts` and omitted on the last attempt, a
  graph record dropped with a note while the chunks and the rest publish, an
  unavailable source failing unretried, query planning, reranking and bounded
  model-assistance fallback.
- `src/rag.conformance.test.ts`: `knowledgeConformance`, its
  `failed-extraction` check on an engine whose helper always answers invalid
  JSON, and its `dropped-record` check on one whose graph has a relation about
  an undefined entity.
- `src/rag-capability.adapter.test.ts`: exact text pins.
- `src/rag.journey.test.ts`: real Agent search/read tools, source citations,
  cited sources' metadata, the exported evidence text, model requests and
  recorded turn context, and search over a document whose graph extraction
  failed, with no keys or network.
- `src/rag-narrowing.journey.test.ts`: two conversations of one owner, each
  narrowed by the host to its own sources, by id and by source metadata,
  search, read and recall only them.
- `src/rag-worker.test.ts`: lease heartbeats, durable defect handling and
  interruption of explicit processing with staged-job recovery.
- Run `env -u HTTP_PROXY -u HTTPS_PROXY bun test packages/plugin-rag`.

No erasure boundaries or new stored framework journal kinds.
