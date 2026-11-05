# @xandreed/plugin-rag

Efferent's native document engine: exact source spans, staged chunking and
embedding, hybrid retrieval, cited reads and optional temporal GraphRAG.
Production imports core only; PostgreSQL persistence is provided separately
through KnowledgeStore. Node 24 and Bun.

## Rules

- Keep personal memory separate: document extraction returns no memories.
- Every operation names owner, namespace and collection. Model tools derive
  owner from RunContext.session.owner; they accept no owner parameter.
- Ingestion enqueues immutable source revisions. Do not replace the published
  document until all chunks, vectors and graph extraction are staged and the
  store accepts the lease, source revision and scope CAS atomically.
- Chunk text and provenance are exact UTF-16 slices of the original source.
  Prefer paragraph, heading and line boundaries; never normalize source text.
- Plain RAG requires KnowledgeStore and EmbeddingModel. Graph extraction is
  opt-in and requires UtilityLlm; extracted entity identities and evidence
  are validated by core before publication. Review is enabled by default.
  Extraction runs through core's `extractKnowledge`: one call (and one
  review) per `maxExtractionChars` window, merged before staging.
- Every UtilityLlm call runs inside `CurrentKnowledgeHelperCall` (purpose,
  scope, job and attempt for extraction and review, `maxHelperOutputTokens`).
  The cap is advisory: only a host's own UtilityLlm that reads the reference
  applies it; the models plugin's `UtilityLlmLive` does not.
- Query planning and reranking use the optional UtilityLlm with a separate
  bound. Invalid or unavailable assistance keeps hybrid evidence; a reranker
  cannot introduce a candidate identity. Explicit traversal coordinates win.
- Keep the original query in the bounded search plan. Combine lexical and
  semantic arms with core's deterministic reciprocal rank fusion. Graph
  expansion applies both temporal coordinates at every hop and shares the
  evidence budget with excerpts.
- Renew processing leases throughout model and embedding work. Serialize
  local processing, coordinate stop with claiming, and count admitted claims
  and claimed work in BackgroundWorkers. Keep masked claim I/O outside the
  admission permit so shutdown can cancel it and report it as busy. Pending
  jobs and sleeping pollers are idle.
- The engine id derives from the embedding options (`knowledgeEngineId`):
  enqueue, discover and claim only under it, never a constant.
- A stopped worker accepts durable ingestion but starts no new work. Scope
  closure interrupts its fiber before its store dependency closes. A failed
  job retains its staged chunks; another worker can resume after retry.
- Tools are read-only. Optional recall is a turn-tier recorded section;
  retrieved text never enters the stable system prefix.

## Public surface

ragPlugin (also default), RagPluginLive, RagLive, RagConfig and ragDefaults.
The main plugin provides Knowledge and contributes Capabilities and
BackgroundWorkers. It requires KnowledgeStore and EmbeddingModel; UtilityLlm
is optional unless graph extraction is enabled.

## Model-facing text

Core owns and pins shared extraction, review, query planning and reranking
prompts. This package owns the following text contracts:

| Text | Source | Pinned by |
|---|---|---|
| Tool descriptions, parameter descriptions, skill summary and failure messages | `src/rag-capability.adapter.ts:12` | exact, `src/rag-capability.adapter.test.ts:11` |
| Retrieved evidence and turn-section rendering | `src/rag.entity.functions.ts:28` | exact, `src/rag-capability.adapter.test.ts:33` |
| Traversal result-limit note | `src/rag.entity.functions.ts:37` | exact, `src/rag-capability.adapter.test.ts:34` |
| Source page framing and continuation | `src/rag.entity.functions.ts:42` | exact, `src/rag-capability.adapter.test.ts:35`; exact, `src/rag-capability.adapter.test.ts:36` |

## Tests

- `src/rag-engine.adapter.test.ts`: exact chunk spans, Unicode, source
  replacement failure/retry, worker restart, owner isolation, forgetting,
  temporal two-hop GraphRAG, document/personal-memory separation, windowed
  graph extraction with exact provenance, helper call contexts, query
  planning, reranking and bounded model-assistance fallback.
- `src/rag-capability.adapter.test.ts`: exact text pins.
- `src/rag.journey.test.ts`: real Agent search/read tools, source citations,
  model requests and recorded turn context, with no keys or network.
- `src/rag-worker.test.ts`: lease heartbeats, durable defect handling and
  interruption of explicit processing with staged-job recovery.
- Run `env -u HTTP_PROXY -u HTTPS_PROXY bun test packages/plugin-rag`.

No erasure boundaries or new stored framework journal kinds.
