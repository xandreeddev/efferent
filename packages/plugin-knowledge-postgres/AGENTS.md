# @xandreed/plugin-knowledge-postgres

Native PostgreSQL and pgvector persistence for long-term memory, knowledge
retrieval and the temporal graph. One scoped connection pool provides all
three ports. Node 24 and Bun use the same `postgres` driver.

## Rules

- Decode every database result through Schema and encode stored values before
  writing them. Parameterize all values; schema and table names are fixed.
- Every domain query carries owner, namespace and collection. Graph traversal
  applies the scope and temporal predicates at every hop.
- A search's `sources` and `metadata` filters are predicates of its lexical
  and semantic statements, before `ORDER BY` and `LIMIT`, never a filter over
  their rows: a metadata filter joins each record to the source revisions it
  cites (`chunks.source_revision`, `record_sources`) and compares top-level
  metadata values by JSON equality. A semantic score is the cosine similarity
  `1 - (embedding <=> query)` (0 for a zero vector), and `minSimilarity` is a
  predicate on that same expression in the semantic statements only, before
  `ORDER BY` and `LIMIT`.
- New derived indexes remain invisible until publication commits. Publication,
  graph revision comparison and leased-job completion share one transaction.
- Deleted sources retain tombstones. Pending work and derived facts cannot
  resurrect them; removing evidence invalidates derived memory and relations.
- Canonical entities merge exact source provenance. Forgetting any source of
  an entity removes it, invalidates references and recursively dependent
  memories, and requeues surviving source jobs with their stages cleared.
  The affected-source closure reaches a fixed point across evidence, entity
  references, record ownership and inferred supports. Every output of a source
  selected for rebuild is invalidated, including unrelated output records and
  chunks, so a partial-source rebuild cannot collide with its old identities.
  Every affected source job loses its staged extraction, including older
  completed revisions; public job status cannot expose forgotten provenance.
  Forgotten raw source revisions and every affected derived payload are
  deleted, including indexed text, vectors, provenance and support links.
  Identity fences and source tombstones remain. Historical superseded records
  remain readable by immutable id until their evidence is forgotten.
- Identity ledgers fence removed chunks as well as historical memories and
  relations. An invalidated or missing record may be rebuilt under the same
  identity only by its original source revision. Observation time is stamped
  at publication; extraction output cannot backdate knowledge.
- Claim jobs with `FOR UPDATE SKIP LOCKED`; a stale or expired lease cannot
  stage or publish. Never hold a SQL transaction while calling a model.
- Discovery and claims (by job id too) see only jobs of the requested engine.
  The failed-job listing reads across owners (and engines unless one is
  given) over the `jobs_failed` index; `requeue` rewrites a job's `engine`
  column with its payload in one transaction.
- Persist and validate embedding profiles and dimensions before storing vectors.
- The migration version only advances transactionally. Never modify a shipped
  migration or silently reset an unsupported schema version.
- Foreign promises use `Effect.tryPromise`; one mapping owns foreign errors:
  `postgresFailure(cause, step)` classifies by SQLSTATE and the step a
  statement runs in (`query`, the migration's `extension` or `layout`).
  Concurrent writes are `Conflict`; a missing or uncreatable pgvector
  extension, a missing privilege and, while migrating, objects that do not fit
  the layout are `Invalid`; connection failures, deadlines and anything else
  stay `Unavailable`, the retryable reason. Messages name the cause and the
  fix, never the connection string or a value; the driver error stays in
  `cause`. Close the pool with its scope and keep server statement deadlines
  bounded.

## Model-facing text

None. The engine plugins own tools and prompt sections.

## Layout

- `src/knowledge-postgres.entity.ts`: connection configuration and defaults,
  the statement steps.
- `src/knowledge-postgres.entity.functions.ts`: the failure mapping.
- `src/postgres-connection.adapter.ts`: pool, queries, transactions and migration.
- `src/knowledge-store.adapter.ts`: the store implementations.
- `src/plugin.adapter.ts`: runtime plugin and its typed layer.

`MemoryStore` and `KnowledgeStore` occupy independent logical domains even if
their scopes have identical strings. `TemporalGraph` reads the memory domain;
the RAG store exposes its own `traverse` method. The default lexical arm uses
PostgreSQL `ts_rank_cd` over a `simple` text configuration; it is not BM25.
The semantic arm uses exact pgvector cosine ranking and validates one stored
embedding identity per domain and scope. Scaling to approximate indexes is a
separate migration and must preserve tenant-filtered recall.

## Public surface

- `knowledgePostgresPlugin` and `KnowledgePostgresPluginLive`: the runtime
  plugin and layer, resolving the secret connection URL with `Config.Redacted`
  from the configured `urlEnv` (default `EFFERENT_KNOWLEDGE_DATABASE_URL`).
- `makeKnowledgePostgres(url, options?)`: opens one scoped pool and returns
  `{ memory, knowledge, graph }`; the URL is a `Redacted<string>`.
- `KnowledgePostgresLive(url, options?)`: provides the three ports with an
  explicit URL. `KnowledgePostgresConfig` and `knowledgePostgresDefaults`
  define connection count and bounded connect/statement deadlines.

First open runs migration layout 1 under a PostgreSQL advisory transaction
lock, and every open then creates the additive indexes it lacks (the partial
index `jobs_failed` that the failed-job listing reads), after reading the
catalog. An index that changes no table or row never bumps the layout, so an
earlier release, which refuses a newer layout, still opens the database; a
change to a table or a row's meaning does bump it. It first probes the catalogs for pgvector (installed in the database or
available on the server) and refuses with `Invalid` when it is neither. The
extension may be installed in advance by a privileged role; the role that
opens the store needs CREATE on the database and on `efferent_knowledge`
(the `IF NOT EXISTS` statements check it even when the objects exist) and
read and write access to its tables. No credentials, tenant names or source
contents belong in migration SQL.

## Tests

Real database tests use `EFFERENT_TEST_POSTGRES_URL` and otherwise `test.skipIf`.
The tests run without model credentials. The host supplies PostgreSQL with the
pgvector extension installed; tests isolate data by owner, namespace and
collection. Both store conformance kits run against the real server. Extra
checks cover pool reopen after durable staging, two-pool lease races, atomic
revision cutover, stale chunk identity fences, recursive forgetting, memory/RAG
domain isolation, publication timestamps, decoding corrupt rows, listing a
job failed before reasons and requeueing it under a new engine column, and a
layout-1 database gaining the failed-job index with its layout unchanged. The
failure mapping is a table test over driver-shaped errors; against a server,
the extension probe and the refusal of an absent extension are checked.
