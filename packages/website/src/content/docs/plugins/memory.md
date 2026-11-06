---
title: Long-term memory
description: Learn evidence-backed facts, preferences, decisions, and temporal relationships across conversations.
pluginId: "@xandreed/plugin-memory"
---

The native memory engine provides `LongTermMemory`. It turns captured sources
into reusable facts, preferences, decisions, recorded actions and supported
observations, with citations and a temporal knowledge graph. Use it when later
conversations should recall relevant earlier interactions.

It complements a window or summary conversation policy. It neither replaces
the session journal nor indexes workspace files automatically.

For a concrete explanation of extraction, graph construction and storage,
indexes, ranking scores and reranking, read
[how memory learns and retrieves](/docs/guides/memory-engine/).

## Install

```sh
npm install @xandreed/plugin-memory @xandreed/plugin-knowledge-postgres
```

Install the shared `effect`, core and SDK packages. Supply PostgreSQL/pgvector,
`UtilityLlm`, and Effect's `EmbeddingModel.EmbeddingModel`. The
[models plugin](/docs/plugins/models/) supplies the helper model, not embeddings.

## Add to an agent

```ts
import { knowledgePostgresPlugin } from "@xandreed/plugin-knowledge-postgres"
import { memoryPlugin } from "@xandreed/plugin-memory"

const plugins = [
  knowledgePostgresPlugin,
  { plugin: memoryPlugin, options: {
    namespace: "assistant",
    collection: "memory",
    embeddingModel: "host-embedding",
    embeddingVersion: "1",
    embeddingDimensions: 768,
    recallChars: 8_000,
    recallLimit: 8,
  } },
]
```

Use these entries in `Agent.define({ plugins })` alongside the remaining
loop, discovery, conversation-memory and session services. Configure the
database URL and supply an embedding service that actually produces the stated
768-dimensional space. Add [capture](/docs/plugins/memory-capture/) with the
same namespace and collection to learn from committed conversations.

## Evidence and time

Sources pass structured extraction and, by default, a review pass before
embedding and atomic publication. Facts and graph entities retain literal
source evidence. Entity matching is conservative; ambiguous names can remain
separate. Model quality still determines whether an extracted claim is useful.

One extraction call reads at most `maxExtractionChars` of a source (48,000 by
default, the same as `maxSourceChars`, so a default source is one call). A
longer source is extracted window by window and the results are merged with
exact whole-source offsets before staging. Each helper call (extraction,
review, planning, reranking) runs with `CurrentKnowledgeHelperCall` set to its
purpose, scope, job and attempt where there is one, and the optional
`maxHelperOutputTokens`, so a host's `UtilityLlm` can budget or refuse it.
That cap is advisory: only a `UtilityLlm` that reads the reference applies
it, and the models plugin's own `UtilityLlmLive` does not.

The graph distinguishes when a fact holds in the world from when it became
known. Queries can specify `validAt` and `knownAt` independently. Changes and
corrections preserve historical beliefs; provenance and temporal filters apply
through graph traversal. Defaults allow two hops, with a maximum of three.

Explicit preferences need no repetition. Inferred routines require evidence
from at least three distinct source episodes. They remain observations and
never grant permission to perform an action. Handler success alone does not
prove that a real-world action succeeded.

## Retrieval and tools

The engine combines lexical and vector retrieval and graph expansion. Bounded
model-assisted query planning (`queryPlanning`) and evidence reranking
(`rerank`) are off by default: each adds one `UtilityLlm` call to every recall,
automatic turn context included, so enable one only when its quality is worth
that cost and latency. A failed or late helper call keeps the deterministic
retrieval. A turn-context section includes
relevant evidence and a small profile. It shares a retrieval deadline and is
recorded as turn context, outside the stable system prefix.

Text and vector search contribute equally through reciprocal rank fusion;
their raw score magnitudes are not combined. Graph traversal adds a bounded
neighborhood separately. Graph assertions have no numeric importance or edge
weight. When enabled, the helper-model reranker can reorder or omit memory
candidates; it does not rerank the graph assertions themselves.

Automatic context also prepends up to four active preference/profile records,
independently of the question's search ranking. See the
[worked retrieval example](/docs/guides/memory-engine/#5-find-memories-for-a-new-question)
for the scores, graph expansion and final prompt path.

Read tools are `recall_memory` and `read_memory`. The separate management skill
exposes `remember_memory` and `forget_memory` under the `memory.write` grant.
A `recall` result's `sources` give the times and metadata of each source
revision it cites. `renderMemoryRecall` and `memorySourcePage`, the text those
tools show, are exported for a host's own tools
([cited sources](/docs/concepts/native-knowledge/#cited-sources-and-evidence-text)).
Model-facing scope comes from the current session's owner, unless the host
narrows it per turn with `KnowledgeNarrowing`: another owner and, optionally,
the only sources recall, reads and the turn-context section may reach, its
profile records included (see
[narrow retrieval per turn](/docs/concepts/native-knowledge/#narrow-retrieval-per-turn)).
Narrowing scopes reads only: saving, forgetting and conversation capture keep
the session owner, and a source outside the listed ones cannot be forgotten.
What conversation capture stores of each committed turn is the host's to
screen with `MemoryCaptureAdmission`: admit it, admit replacement text, or
refuse it, so it is never recalled (see
[screen turns before capture](/docs/plugins/memory-capture/#screen-turns-before-capture)).
The catch-up the recall section runs before recalling asks it too.
Host APIs explicitly name owner, namespace and collection, and `recall` takes a
`sources` filter.

## Processing, persistence and forgetting

Capture returning a job means durable acceptance, not completed learning.
The runtime worker processes it asynchronously. Inspect `status`, use `retry`,
or set `worker: false` and schedule bounded `process(scope, limit)` calls.
Model or embedding failures publish no partial knowledge; valid staged
extraction can survive retry. Shutdown stops new claims and bounds active work.

Captured jobs are recorded under an engine id derived from the embedding
options (`knowledgeEngineId("memory:1", { model, version, dimensions })`). The
worker and `process` discover and claim only jobs of that id, so engines
configured with different embedding spaces on one store never learn from each
other's sources. After changing the embedding options, capture the source again
as its next revision to process it under the new configuration.

`forget` tombstones a source and removes its text and dependent learned
knowledge, including historical graph evidence. Backfill cannot resurrect that
source. Original session journals and database backups require their own
retention policy. See [capture](/docs/plugins/memory-capture/),
[RAG](/docs/plugins/rag/) for documents, and
[context and the journal](/docs/concepts/context-journal/) for the full data path.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-memory` · Version **0.17.1** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `@xandreed/core/LongTermMemory` |
| Requires | `@xandreed/core/MemoryStore`, `@xandreed/core/UtilityLlm`, `effect/ai/EmbeddingModel` |
| Uses when available | none |
| Contributes | `efferent/Capabilities`, `@xandreed/core/BackgroundWorkers` |

### Default options

```json
{
  "namespace": "default",
  "collection": "memory",
  "embeddingModel": "host",
  "embeddingVersion": "1",
  "embeddingDimensions": 1536,
  "review": true,
  "consolidate": true,
  "queryPlanning": false,
  "rerank": false,
  "retrievalTimeoutMs": 10000,
  "worker": true,
  "pollMs": 2000,
  "batchSize": 10,
  "maxAttempts": 3,
  "leaseMs": 180000,
  "modelTimeoutMs": 60000,
  "maxSourceChars": 48000,
  "maxExtractionChars": 48000,
  "maxCandidateChars": 32000,
  "recallChars": 8000,
  "recallLimit": 8,
  "graphDepth": 2,
  "sectionOrder": 700,
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
    "review": {
      "type": "boolean"
    },
    "consolidate": {
      "type": "boolean"
    },
    "queryPlanning": {
      "type": "boolean"
    },
    "rerank": {
      "type": "boolean"
    },
    "retrievalTimeoutMs": {
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
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "maxExtractionChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "minimum": 1000
    },
    "maxHelperOutputTokens": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "maxCandidateChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "recallChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "recallLimit": {
      "type": "integer",
      "maximum": 100,
      "exclusiveMinimum": 0
    },
    "graphDepth": {
      "type": "integer",
      "maximum": 3,
      "exclusiveMinimum": 0
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
    "review",
    "consolidate",
    "queryPlanning",
    "rerank",
    "retrievalTimeoutMs",
    "worker",
    "pollMs",
    "batchSize",
    "maxAttempts",
    "leaseMs",
    "modelTimeoutMs",
    "maxSourceChars",
    "maxExtractionChars",
    "maxCandidateChars",
    "recallChars",
    "recallLimit",
    "graphDepth",
    "sectionOrder",
    "tools"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
