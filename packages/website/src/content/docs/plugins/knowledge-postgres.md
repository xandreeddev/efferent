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
It first checks that pgvector is installed in the database or available on
the server. Use an administrative role to install pgvector before running
with a restricted application role. The role that opens the store needs
CREATE on the database and on the `efferent_knowledge` schema, which the
migration's `IF NOT EXISTS` statements check even when the objects exist,
and read and write access to its tables.
Efferent owns its tables under `efferent_knowledge`.

## Failures

Every store method fails with a `KnowledgeError` whose `reason` says what a
caller can do about it:

| Reason | When | Retry? |
| --- | --- | --- |
| `Unavailable` | The server cannot be reached, a connection closes, the pool is exhausted, a statement or lock deadline elapses | Yes, with a backoff |
| `Conflict` | A concurrent write won: a unique violation, a serialization failure, a deadlock | Yes, after reading again |
| `Invalid` | pgvector is not installed on the server, the role may not create the extension or the schema, the role lacks a privilege on the tables, or the existing `efferent_knowledge` objects do not fit the layout (an object of another shape, or the `vector` type outside the role's search path) | No: fix the setup the message names |
| `Corrupt` | A stored row no longer matches its schema | No |

The reason comes from the server's SQLSTATE and the step that failed: the
same privilege error reads as an uncreatable extension while migration
installs pgvector, and as a missing table grant in an ordinary query. An
`Invalid` message names the cause and the fix, never the connection string
or a value; the driver's error is kept as the `cause` for logs.

Memory and document retrieval occupy separate logical domains, even when
owner, namespace and collection strings match. Every operation is scoped by
those three coordinates. `TemporalGraph` reads the memory domain; the document
store exposes its own graph traversal. `sourceInfo` reads the times and metadata
of every source revision a retrieval cites in one query, without their text.

A search's `sources` filter is applied in SQL, before ranking and limits: a
chunk's source must be listed, and a memory is returned only when none of its
recorded source links names an unlisted source, leaving aside the links of the
revisions that restated it later (a stated memory's mentions after the first).
Those revisions' spans and mentions are taken out of a returned memory when the
filter does not admit them (`narrowKnowledgeMemory`). An empty list returns
nothing.

A search's `metadata` filter is applied in SQL as well, inside the lexical and
semantic statements, before `ORDER BY` and `LIMIT`: each chunk is joined to the
source revision it cites, and a memory is returned only when every source
revision its recorded links name matches, later restatements aside as for
`sources`. Each key is compared by JSON equality
with the revision's top-level metadata value. The joins use the tables' primary
keys, so the filter needs no layout change and no new index.

The lexical arm uses PostgreSQL text ranking with the `simple` configuration.
The vector arm uses exact pgvector cosine ranking: a semantic score is the
cosine similarity `1 - (embedding <=> query)`, 0 for a zero vector. A search's
`minSimilarity` is one more predicate on that expression in the semantic
statements only, before `ORDER BY` and `LIMIT`, so records below the floor
take no place of the limit and the lexical arm keeps them
([a similarity floor](/docs/concepts/native-knowledge/#near-duplicates-and-a-similarity-floor)).
This is not a BM25 or an
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

Each job row records its engine id, which names the engine and its embedding
space. Discovery and claims, a claim by job id included, filter on it, so
workers configured with different embedding spaces can share the database
without taking each other's jobs. The adapter passes
`knowledgeStoreConformance`, including its `knowledge.engine-isolation` check.

A failed job keeps the failure it was failed with (`KnowledgeJobFailure`:
reason, message, step and, for a failed extraction, its `diagnostic`) in its
stored payload, and `failed` lists it whole; the row's `phase` column still
reads `Failed`, and the layout is unchanged. A job failed by an earlier
release, whose payload has only a message, decodes with reason `Unavailable`
at step `Required`, and one failed before diagnostics decodes without one.

A stage's notes, `GraphOmitted` and `RecordDropped` (the extracted records
staging left out), are part of the job's stored payload, and an assertion's
`validFromBasis` is part of its payload; neither has a column, so the layout
is unchanged. A stage or an assertion an earlier release wrote, with only
`GraphOmitted` notes or no basis, decodes unchanged (an assertion without a
basis reads as stated). The adapter passes `knowledgeStoreConformance`'s
`knowledge.stage-notes` check.

A successor's `replaces` links (to the memories it retired, a relation's
history copy or a corrected relation) are part of the successor's payload,
with no column, so the layout is unchanged. Publication writes nothing to a
retired row but its `known_to`, so a retired memory stays readable by id
(`memory`) until its source is forgotten; forgetting it leaves a successor's
link dangling, and recall skips such a link. A memory or relation an earlier
release wrote has no links and decodes unchanged. The adapter passes
`knowledgeStoreConformance`'s `knowledge.supersession-links` check.

A memory's `mentions`, the source revisions whose own text states it, are part
of its payload too, with no column: every mention is a revision its provenance
cites, so `record_sources` already holds it, and forgetting a mentioned source
removes the memory through the same closure as the rest of its evidence. A
memory an earlier release wrote has no mentions and decodes unchanged. The
adapter passes `knowledgeStoreConformance`'s `knowledge.mentions` check.

A stage's `corroborations` live in the job's payload, and publication applies
them in its transaction with no DDL: it locks each corroborated memory's row,
fails with `Conflict` (and writes nothing) when the row is no longer active,
which includes a memory that publication itself just retired, and otherwise
rewrites the row's payload with the corroboration's spans and mention and adds
its `record_sources` rows. A later revision of a source retires the active
memories the `identities` table says the source published, as before, while a
memory another source published that cites an earlier revision of it (as a
corroboration, or through an entity it defined) keeps its row: the payload
loses that revision's spans and mention and its `record_sources` rows for that
revision are deleted. Forgetting a corroborating source purges the memory
through the `record_sources` closure and requeues its other sources. A stage or
memory an earlier release wrote has no corroborations and decodes unchanged.
A narrowed search reads the corroborating revisions from the payload's
`mentions` and leaves their `record_sources` rows out of the narrowing, so a
restatement from outside the filter neither hides the memory nor shows in it.
The adapter passes `knowledgeStoreConformance`'s `knowledge.corroboration`,
`knowledge.corroboration-conflict`, `knowledge.corroboration-revision`,
`knowledge.corroboration-reach` and `knowledge.corroboration-superseded`
checks.

`failed` lists failed jobs across owners from the row's `phase`, `engine` and
`collection` columns, in the rows' recording order; its cursor is the last
row's ordinal. A reasons filter reads the reason in the payload, and a job
failed before reasons were recorded matches `Unavailable`. It reads the
partial index `jobs_failed` (`domain, namespace, ordinal` over failed rows),
which opening the store creates when it is missing. The index changes no table
or row, so the layout stays 1 and an earlier release still opens the database
(a rollback, or an older instance during a rolling deploy). Creating it blocks
writes to the jobs table while it builds, once; for a large table, create it
beforehand without blocking writes, and the open finds it:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_failed
  ON efferent_knowledge.jobs (domain, namespace, ordinal) WHERE phase = 'Failed';
```

`requeue` rewrites the row's `engine` column with its payload, so
discovery and claims of the new engine find the job at once.

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

Plugin: `@xandreed/plugin-knowledge-postgres` · Version **0.22.0** · Plugin API **3** · Scope **runtime**

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
