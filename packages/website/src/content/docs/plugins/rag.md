---
title: Document RAG
description: Ingest text revisions and retrieve cited passages with optional temporal GraphRAG.
pluginId: "@xandreed/plugin-rag"
---

The native RAG engine provides `Knowledge`: document ingestion, hybrid search,
cited source reads, and optional graph extraction. Use it for manuals,
workspace documents or connector data that an assistant needs to consult.

RAG preserves document passages. [Long-term memory](/docs/plugins/memory/)
derives reusable knowledge from interactions. Their stores are independent;
neither engine automatically reads every workspace file.

## Install

```sh
npm install @xandreed/plugin-rag @xandreed/plugin-knowledge-postgres
```

Install the shared `effect`, core and SDK packages. Plain RAG needs a
`KnowledgeStore` and a host-supplied `EmbeddingModel.EmbeddingModel`.
[Models](/docs/plugins/models/) does not provide the embedding service.

## Add to an agent

```ts
import { knowledgePostgresPlugin } from "@xandreed/plugin-knowledge-postgres"
import { ragPlugin } from "@xandreed/plugin-rag"

const plugins = [
  knowledgePostgresPlugin,
  { plugin: ragPlugin, options: {
    namespace: "assistant",
    collection: "handbooks",
    embeddingModel: "host-embedding",
    embeddingVersion: "1",
    embeddingDimensions: 768,
    graph: false,
    chunkChars: 2_000,
    overlapChars: 200,
    recall: false,
  } },
]
```

Use these entries in `Agent.define({ plugins })` with the rest of your loop,
conversation-memory and session graph. Configure the PostgreSQL URL and supply
an embedding service producing the actual configured vector space. Documents
must also be ingested through the host's `Knowledge` service; composition alone
does not create a corpus.

## Ingestion and source revisions

The host supplies extracted text or Markdown, source identity, integer revision,
timestamps, metadata and explicit owner/namespace/collection scope. It handles
file reading, PDF parsing, network fetches and connectors. Structure-aware
chunking prefers headings, paragraphs and lines while preserving exact UTF-16
source offsets. `overlapChars` cannot exceed half of `chunkChars`.

`ingest` returns a durable job. The worker stages chunks, embeddings and any
graph extraction before atomic publication. When replacing a document, provide
the expected previous revision. Its published index stays searchable until the
new revision is ready; a failure does not expose a half-built replacement.

Use `status`, `retry`, and `process` for host-controlled operation. With
`worker: false`, the host must schedule processing. Workers otherwise recover
durable jobs after restart and renew leases during processing.

Jobs are recorded under an engine id derived from the embedding options
(`knowledgeEngineId("rag:1", { model, version, dimensions })`, for example
`rag:1/host-embedding/1/768`). The worker and `process` discover and claim only
jobs of that id, so engines configured with different embedding spaces on one
store never index each other's documents. After changing the embedding
options, a job queued under the earlier configuration is processed only by an
engine still configured that way; ingest the source again as its next revision
to index it under the new one.

## Search, graph and model context

The read-only tools are `search_knowledge` and `read_knowledge`. Results carry
source references and bounded excerpts; a source read can continue by offset.
Tool scope derives from the session owner. The host APIs accept explicit scopes.
Set `recall: true` to inject bounded retrieved evidence into recorded turn
context automatically; the default leaves retrieval to tools or host calls.

`graph: true` enables document entity and relationship extraction and requires
`UtilityLlm`. Review is enabled by default. Optional query planning and reranking
use that helper when available; invalid or unavailable assistance falls back
to deterministic lexical/vector retrieval. The total foreground query,
including embedding and graph traversal, is bounded by `queryTimeoutMs`.

Graph queries distinguish world time from recorded knowledge time, with both
coordinates applied at every hop. Historical graph queries do not turn the
current chunk index into a historical search index: read an older source by
its explicit revision. Forgetting tombstones the source and invalidates its
dependent evidence; original files and backups have separate retention.

## Related guides

See [PostgreSQL storage](/docs/plugins/knowledge-postgres/) for provisioning,
[native knowledge](/docs/concepts/native-knowledge/) for a complete ingestion
example, and [context and the journal](/docs/concepts/context-journal/) for how
retrieved passages enter model requests without becoming fresh capture evidence.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-rag` · Version **0.17.1** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `@xandreed/core/Knowledge` |
| Requires | `@xandreed/core/KnowledgeStore`, `effect/ai/EmbeddingModel` |
| Uses when available | `@xandreed/core/UtilityLlm` |
| Contributes | `@xandreed/core/BackgroundWorkers`, `efferent/Capabilities` |

### Default options

```json
{
  "namespace": "default",
  "collection": "knowledge",
  "embeddingModel": "host",
  "embeddingVersion": "1",
  "embeddingDimensions": 1536,
  "graph": false,
  "review": true,
  "queryPlanning": true,
  "rerank": true,
  "queryTimeoutMs": 10000,
  "worker": true,
  "pollMs": 2000,
  "batchSize": 10,
  "maxAttempts": 3,
  "leaseMs": 180000,
  "modelTimeoutMs": 60000,
  "maxSourceChars": 200000,
  "maxCandidateChars": 32000,
  "chunkChars": 2000,
  "overlapChars": 200,
  "embeddingBatchSize": 32,
  "searchLimit": 8,
  "evidenceChars": 8000,
  "readChars": 8000,
  "graphDepth": 2,
  "recall": false,
  "sectionOrder": 720,
  "tools": true
}
```

### Options schema

<details>
<summary>Show the full configuration schema</summary>

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "namespace": {
      "type": "string",
      "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      "minLength": 1
    },
    "collection": {
      "type": "string",
      "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      "minLength": 1
    },
    "embeddingModel": {
      "type": "string",
      "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      "minLength": 1
    },
    "embeddingVersion": {
      "type": "string",
      "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      "minLength": 1
    },
    "embeddingDimensions": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "graph": {
      "type": "boolean"
    },
    "review": {
      "type": "boolean"
    },
    "queryPlanning": {
      "type": "boolean"
    },
    "rerank": {
      "type": "boolean"
    },
    "queryTimeoutMs": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "worker": {
      "type": "boolean"
    },
    "pollMs": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "batchSize": {
      "type": "integer",
      "maximum": 100,
      "exclusiveMinimum": 0
    },
    "maxAttempts": {
      "type": "integer",
      "maximum": 10,
      "exclusiveMinimum": 0
    },
    "leaseMs": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "modelTimeoutMs": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "maxSourceChars": {
      "type": "integer",
      "maximum": 2000000,
      "exclusiveMinimum": 0
    },
    "maxCandidateChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "chunkChars": {
      "type": "integer",
      "maximum": 16000,
      "minimum": 200
    },
    "overlapChars": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "embeddingBatchSize": {
      "type": "integer",
      "maximum": 100,
      "exclusiveMinimum": 0
    },
    "searchLimit": {
      "type": "integer",
      "maximum": 100,
      "exclusiveMinimum": 0
    },
    "evidenceChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "readChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "graphDepth": {
      "type": "integer",
      "maximum": 3,
      "exclusiveMinimum": 0
    },
    "recall": {
      "type": "boolean"
    },
    "sectionOrder": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "tools": {
      "type": "boolean"
    }
  },
  "required": [
    "namespace",
    "collection",
    "embeddingModel",
    "embeddingVersion",
    "embeddingDimensions",
    "graph",
    "review",
    "queryPlanning",
    "rerank",
    "queryTimeoutMs",
    "worker",
    "pollMs",
    "batchSize",
    "maxAttempts",
    "leaseMs",
    "modelTimeoutMs",
    "maxSourceChars",
    "maxCandidateChars",
    "chunkChars",
    "overlapChars",
    "embeddingBatchSize",
    "searchLimit",
    "evidenceChars",
    "readChars",
    "graphDepth",
    "recall",
    "sectionOrder",
    "tools"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
