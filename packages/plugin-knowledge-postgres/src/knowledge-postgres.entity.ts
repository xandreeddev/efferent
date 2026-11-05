import { Schema } from "effect"

/** Connection and resource bounds for the native PostgreSQL knowledge store. @public */
export const KnowledgePostgresConfig = Schema.Struct({
  /** Environment variable containing the PostgreSQL URL; decoded as a secret. */
  urlEnv: Schema.Trimmed.check(Schema.isNonEmpty()),
  /** Maximum number of open PostgreSQL connections. */
  connections: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  /** Per-statement server deadline, including lock acquisition. */
  statementTimeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120_000 })),
  /** Connection establishment deadline. */
  connectTimeoutSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
})
export type KnowledgePostgresConfig = typeof KnowledgePostgresConfig.Type

/** @public */
export const knowledgePostgresDefaults: KnowledgePostgresConfig = {
  urlEnv: "EFFERENT_KNOWLEDGE_DATABASE_URL",
  connections: 4,
  statementTimeoutMs: 15_000,
  connectTimeoutSeconds: 10,
}

/**
 * The step a PostgreSQL statement runs in, which decides what a misconfiguration means: an
 * ordinary `query`, the migration's `extension` step (pgvector) or its `layout` step (the
 * `efferent_knowledge` schema, its tables and its layout version).
 */
export const PostgresStep = Schema.Literals(["query", "extension", "layout"])
export type PostgresStep = typeof PostgresStep.Type

/** The extension that stores and ranks embeddings. */
export const VECTOR_EXTENSION = "vector"
