---
title: Knowledge PostgreSQL
description: Persist native memory, document indexes, temporal graphs, and durable processing jobs.
pluginId: "@xandreed/plugin-knowledge-postgres"
---

This plugin supplies `MemoryStore`, `KnowledgeStore` and `TemporalGraph` through
one scoped PostgreSQL connection pool. Use it as the durable storage layer for
Efferent's [memory engine](/docs/plugins/memory/) and [RAG engine](/docs/plugins/rag/).
It stores evidence, vectors, graph records, jobs, stages and tombstones.

It does not run extraction, call models, capture conversations, or persist the
session journal. Those responsibilities have separate plugins and lifetimes.

## Install and provision

```sh
npm install @xandreed/plugin-knowledge-postgres
```

Install the shared `effect` and core packages. Both Node 24 and Bun use the
same PostgreSQL driver. Provision a PostgreSQL server with pgvector available;
this package does not start a database server.

Configure the secret `EFFERENT_KNOWLEDGE_DATABASE_URL` through your host's
Effect `ConfigProvider`, normally an environment variable. Never put its value
in source code. The variable name can be changed with `urlEnv`.

## Add to an agent

```ts
import { knowledgePostgresPlugin } from "@xandreed/plugin-knowledge-postgres"

const plugins = [
  { plugin: knowledgePostgresPlugin, options: {
    urlEnv: "EFFERENT_KNOWLEDGE_DATABASE_URL",
    connections: 4,
    statementTimeoutMs: 15_000,
    connectTimeoutSeconds: 10,
  } },
]
```

Use the entries in `Agent.define({ plugins })` with memory, RAG, or both.
The engines still need a host-supplied `EmbeddingModel`; memory and graph
extraction also need `UtilityLlm`. Your agent separately needs its loop,
conversation context strategy and session backend.

## Schema, isolation and retrieval

First open runs versioned migrations under an advisory transaction lock.
The initial role needs permission to create the extension, schema and tables,
or those objects must already be provisioned. Use an administrative role to
install pgvector before running with a restricted application role.
Efferent owns its tables under `efferent_knowledge`.

Memory and document retrieval occupy separate logical domains, even when
owner, namespace and collection strings match. Every operation is scoped by
those three coordinates. `TemporalGraph` reads the memory domain; the document
store exposes its own graph traversal.

The lexical arm uses PostgreSQL text ranking with the `simple` configuration.
The vector arm uses exact pgvector cosine ranking. This is not a BM25 or an
approximate-nearest-neighbor implementation. Measure corpus size and query cost
before relying on large-scale performance.

The migrations create GIN full-text indexes and scoped indexes on graph
assertion subjects and entity objects. They do not create HNSW or IVFFlat
vector indexes. See [the memory engine walkthrough](/docs/guides/memory-engine/)
for example stored rows and how those indexes serve different retrieval steps.

Each domain and scope records an embedding identity and dimensions. Configure
the engine to match the actual host embedding service. A model change requires
a new collection or deliberate reindexing, not merely a new option value.

## Durability and lifecycle

Jobs use leases and atomic publication: staged output remains invisible until
the source revision, lease and scope checks pass. The database transaction
never stays open while a model runs. Restarted workers can recover durable
pending work and reuse valid stages.

The runtime-scoped pool closes with its owning scope. Keep engines and their
workers inside that scope, and use the agent's bounded shutdown before closing
host services. Sleeping workers and queued jobs are not active work.

Forgetting removes source payloads and dependent indexes while retaining
minimal identity fences and tombstones. Database backups and the original
conversation journal have separate retention policies.

Hosts managing credentials directly can use `KnowledgePostgresLive` with a
`Redacted<string>` URL, or scoped `makeKnowledgePostgres` to obtain the three
stores. See [native knowledge](/docs/concepts/native-knowledge/) for a complete
layer example and [context and the journal](/docs/concepts/context-journal/)
for the two independent persistence paths.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-knowledge-postgres` · Version **0.17.0** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `@xandreed/core/MemoryStore`, `@xandreed/core/KnowledgeStore`, `@xandreed/core/TemporalGraph` |
| Requires | none |
| Uses when available | none |
| Contributes | none |

### Default options

```json
{
  "urlEnv": "EFFERENT_KNOWLEDGE_DATABASE_URL",
  "connections": 4,
  "statementTimeoutMs": 15000,
  "connectTimeoutSeconds": 10
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
    "urlEnv": {
      "type": "string",
      "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      "minLength": 1
    },
    "connections": {
      "type": "integer",
      "minimum": 1,
      "maximum": 32
    },
    "statementTimeoutMs": {
      "type": "integer",
      "minimum": 1,
      "maximum": 120000
    },
    "connectTimeoutSeconds": {
      "type": "integer",
      "minimum": 1,
      "maximum": 60
    }
  },
  "required": [
    "urlEnv",
    "connections",
    "statementTimeoutMs",
    "connectTimeoutSeconds"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
