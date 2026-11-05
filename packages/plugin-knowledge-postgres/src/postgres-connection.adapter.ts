import postgres from "postgres"
import { Effect, Exit, Redacted, Schema } from "effect"
import { KnowledgeError } from "@xandreed/core"
import { VECTOR_EXTENSION } from "./knowledge-postgres.entity.js"
import type { KnowledgePostgresConfig, PostgresStep } from "./knowledge-postgres.entity.js"
import { missingVectorExtension, postgresFailure } from "./knowledge-postgres.entity.functions.js"

/** The driver stays behind this parameterized query boundary. */
export interface PostgresQueries {
  readonly rows: <S extends Schema.Decoder<unknown>>(schema: S, statement: string, parameters?: ReadonlyArray<string | number | boolean | null>) => Effect.Effect<ReadonlyArray<S["Type"]>, KnowledgeError, S["DecodingServices"]>
  readonly execute: (statement: string, parameters?: ReadonlyArray<string | number | boolean | null>) => Effect.Effect<void, KnowledgeError>
  /** The same connection, its failures read as failures of `step` (`postgresFailure`). */
  readonly at: (step: PostgresStep) => PostgresQueries
}

export interface PostgresDatabase extends PostgresQueries {
  readonly transaction: <A>(use: (queries: PostgresQueries) => Effect.Effect<A, KnowledgeError>) => Effect.Effect<A, KnowledgeError>
}

/** Every driver failure maps through `postgresFailure`, the only foreign failure mapping. */
const promise = <A>(work: () => PromiseLike<A>, step: PostgresStep = "query"): Effect.Effect<A, KnowledgeError> =>
  Effect.tryPromise({ try: () => Promise.resolve(work()), catch: (cause) => postgresFailure(cause, step) })

const queries = (sql: postgres.Sql | postgres.ReservedSql, step: PostgresStep = "query"): PostgresQueries => ({
  rows: (schema, statement, parameters = []) => promise(() => sql.unsafe(statement, [...parameters]), step).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(schema))),
    Effect.mapError((cause) => cause._tag === "KnowledgeError" ? cause : new KnowledgeError({ reason: "Corrupt", message: "a PostgreSQL knowledge row does not match its schema", cause })),
  ),
  execute: (statement, parameters = []) => promise(() => parameters.length === 0 ? sql.unsafe(statement).simple() : sql.unsafe(statement, [...parameters]), step).pipe(Effect.asVoid),
  at: (next) => queries(sql, next),
})

/** One scoped PostgreSQL pool. Reserved connections keep transactions on one backend. */
export const makePostgresDatabase = Effect.fn("knowledge_postgres.open")(function* (
  url: Redacted.Redacted<string>,
  config: KnowledgePostgresConfig,
) {
  const sql = yield* Effect.acquireRelease(
    Effect.try({
      try: () => postgres(Redacted.value(url), {
        max: config.connections,
        connect_timeout: config.connectTimeoutSeconds,
        idle_timeout: 20,
        connection: { statement_timeout: config.statementTimeoutMs, lock_timeout: config.statementTimeoutMs },
        onnotice: () => {},
      }),
      catch: (cause) => postgresFailure(cause, "query"),
    }),
    (pool) => promise(() => pool.end({ timeout: 5 })).pipe(Effect.ignore({ log: "Warn", message: "closing the PostgreSQL knowledge pool failed" })),
  )
  const base = queries(sql)
  const transaction = <A>(use: (connection: PostgresQueries) => Effect.Effect<A, KnowledgeError>): Effect.Effect<A, KnowledgeError> =>
    Effect.uninterruptibleMask((restore) => Effect.acquireUseRelease(
      promise(() => sql.reserve()),
      (connection) => {
        const tx = queries(connection)
        return tx.execute("BEGIN").pipe(
          Effect.andThen(Effect.exit(restore(Effect.suspend(() => use(tx))))),
          Effect.flatMap((exit) => Exit.match(exit, {
            onSuccess: (value) => tx.execute("COMMIT").pipe(Effect.as(value)),
            onFailure: Effect.failCause,
          })),
        )
      },
      (connection, exit) => (Exit.isFailure(exit)
        ? queries(connection).execute("ROLLBACK").pipe(Effect.ignore({ log: "Warn", message: "rolling back a knowledge transaction failed" }))
        : Effect.void).pipe(Effect.ensuring(Effect.sync(() => connection.release()))),
    ))
  return { ...base, transaction }
})

/** Schema layout 1. New migrations append; published layouts are immutable. */
const LAYOUT_ONE = `
CREATE TABLE IF NOT EXISTS efferent_knowledge.scopes (
  domain text NOT NULL, owner text NOT NULL, namespace text NOT NULL, collection text NOT NULL,
  version bigint NOT NULL DEFAULT 0, embedding_profile jsonb,
  PRIMARY KEY (domain, owner, namespace, collection)
);
CREATE TABLE IF NOT EXISTS efferent_knowledge.heads (
  domain text NOT NULL, owner text NOT NULL, namespace text NOT NULL, collection text NOT NULL,
  source_id text NOT NULL, accepted_revision bigint NOT NULL DEFAULT 0, published_revision bigint,
  tombstone_at bigint,
  PRIMARY KEY (domain, owner, namespace, collection, source_id)
);
CREATE TABLE IF NOT EXISTS efferent_knowledge.sources (
  domain text NOT NULL, owner text NOT NULL, namespace text NOT NULL, collection text NOT NULL,
  source_id text NOT NULL, revision bigint NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY (domain, owner, namespace, collection, source_id, revision)
);
CREATE TABLE IF NOT EXISTS efferent_knowledge.jobs (
  domain text NOT NULL, owner text NOT NULL, namespace text NOT NULL, collection text NOT NULL,
  id text NOT NULL, source_id text NOT NULL, source_revision bigint NOT NULL, engine text NOT NULL,
  phase text NOT NULL, lease_token text, lease_until bigint, ordinal bigint GENERATED ALWAYS AS IDENTITY,
  payload jsonb NOT NULL,
  PRIMARY KEY (domain, owner, namespace, collection, id),
  UNIQUE (domain, owner, namespace, collection, source_id, source_revision, engine)
);
CREATE INDEX IF NOT EXISTS jobs_claim ON efferent_knowledge.jobs
  (domain, owner, namespace, collection, phase, ordinal);
CREATE TABLE IF NOT EXISTS efferent_knowledge.memories (
  domain text NOT NULL, owner text NOT NULL, namespace text NOT NULL, collection text NOT NULL,
  id text NOT NULL, text text NOT NULL, payload jsonb NOT NULL, embedding vector,
  known_from bigint NOT NULL, known_to bigint, invalidated boolean NOT NULL DEFAULT false,
  lexical tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  PRIMARY KEY (domain, owner, namespace, collection, id)
);
CREATE INDEX IF NOT EXISTS memories_lexical ON efferent_knowledge.memories USING gin (lexical);
CREATE TABLE IF NOT EXISTS efferent_knowledge.chunks (
  domain text NOT NULL, owner text NOT NULL, namespace text NOT NULL, collection text NOT NULL,
  id text NOT NULL, source_id text NOT NULL, source_revision bigint NOT NULL,
  text text NOT NULL, payload jsonb NOT NULL, embedding vector,
  lexical tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  PRIMARY KEY (domain, owner, namespace, collection, id)
);
CREATE INDEX IF NOT EXISTS chunks_source ON efferent_knowledge.chunks
  (domain, owner, namespace, collection, source_id);
CREATE INDEX IF NOT EXISTS chunks_lexical ON efferent_knowledge.chunks USING gin (lexical);
CREATE TABLE IF NOT EXISTS efferent_knowledge.entities (
  domain text NOT NULL, owner text NOT NULL, namespace text NOT NULL, collection text NOT NULL,
  id text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY (domain, owner, namespace, collection, id)
);
CREATE TABLE IF NOT EXISTS efferent_knowledge.assertions (
  domain text NOT NULL, owner text NOT NULL, namespace text NOT NULL, collection text NOT NULL,
  id text NOT NULL, subject text NOT NULL, predicate text NOT NULL, object_entity text,
  valid_from bigint, valid_to bigint, known_from bigint NOT NULL, known_to bigint,
  invalidated boolean NOT NULL DEFAULT false, payload jsonb NOT NULL,
  PRIMARY KEY (domain, owner, namespace, collection, id)
);
CREATE INDEX IF NOT EXISTS assertions_subject ON efferent_knowledge.assertions
  (domain, owner, namespace, collection, subject);
CREATE INDEX IF NOT EXISTS assertions_object ON efferent_knowledge.assertions
  (domain, owner, namespace, collection, object_entity);
CREATE TABLE IF NOT EXISTS efferent_knowledge.record_sources (
  domain text NOT NULL, owner text NOT NULL, namespace text NOT NULL, collection text NOT NULL,
  kind text NOT NULL, record_id text NOT NULL, source_id text NOT NULL, source_revision bigint NOT NULL,
  PRIMARY KEY (domain, owner, namespace, collection, kind, record_id, source_id, source_revision)
);
CREATE INDEX IF NOT EXISTS record_sources_source ON efferent_knowledge.record_sources
  (domain, owner, namespace, collection, source_id, kind, record_id);
CREATE TABLE IF NOT EXISTS efferent_knowledge.memory_supports (
  domain text NOT NULL, owner text NOT NULL, namespace text NOT NULL, collection text NOT NULL,
  memory_id text NOT NULL, support_id text NOT NULL,
  PRIMARY KEY (domain, owner, namespace, collection, memory_id, support_id)
);
CREATE TABLE IF NOT EXISTS efferent_knowledge.identities (
  domain text NOT NULL, owner text NOT NULL, namespace text NOT NULL, collection text NOT NULL,
  kind text NOT NULL, id text NOT NULL, source_id text NOT NULL, source_revision bigint NOT NULL,
  PRIMARY KEY (domain, owner, namespace, collection, kind, id)
);
`

/**
 * Whether the database can have the extension `name`: installed in it already, or available on
 * the server for `CREATE EXTENSION`. Read from the catalogs, which every role may read.
 */
export const extensionAvailable = (queries: PostgresQueries, name: string): Effect.Effect<boolean, KnowledgeError> =>
  queries.rows(
    Schema.Struct({ available: Schema.Boolean }),
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) OR EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = $1) AS available",
    [name],
  ).pipe(Effect.map((rows) => rows.some((row) => row.available)))

/**
 * Migration is serialized across processes, with an explicit newer-layout refusal. A server
 * without pgvector, a role that may not create what is missing and a database whose objects do
 * not fit the layout fail as `Invalid`, naming the cause; an outage stays `Unavailable`.
 */
export const migratePostgres = Effect.fn("knowledge_postgres.migrate")(function* (database: PostgresDatabase) {
  yield* database.transaction((tx) => Effect.gen(function* () {
    yield* tx.execute("SELECT pg_advisory_xact_lock(787418260114)")
    const extension = tx.at("extension")
    if (!(yield* extensionAvailable(extension, VECTOR_EXTENSION))) return yield* Effect.fail(missingVectorExtension())
    yield* extension.execute("CREATE EXTENSION IF NOT EXISTS vector")
    const layout = tx.at("layout")
    yield* layout.execute("CREATE SCHEMA IF NOT EXISTS efferent_knowledge")
    yield* layout.execute("CREATE TABLE IF NOT EXISTS efferent_knowledge.layout (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), version integer NOT NULL)")
    const rows = yield* layout.rows(Schema.Struct({ version: Schema.Int }), "SELECT version FROM efferent_knowledge.layout WHERE singleton = true")
    const version = rows[0]?.version ?? 0
    if (version > 1) return yield* Effect.fail(new KnowledgeError({ reason: "Invalid", message: "the knowledge database layout is newer than this implementation" }))
    if (version === 0) {
      yield* layout.execute(LAYOUT_ONE)
      yield* layout.execute("INSERT INTO efferent_knowledge.layout (singleton, version) VALUES (true, 1)")
    }
  }))
})
