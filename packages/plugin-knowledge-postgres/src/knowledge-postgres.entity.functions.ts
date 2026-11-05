import { Match, Option } from "effect"
import { errorCodeOf, KnowledgeError } from "@xandreed/core"
import type { PostgresStep } from "./knowledge-postgres.entity.js"

/** A write lost to a concurrent one: a unique violation, a serialization failure, a deadlock. */
const CONFLICTS: ReadonlyArray<string> = ["23505", "40001", "40P01"]
/** The server cannot load an extension: feature not supported (PostgreSQL 15 and later), an undefined file (earlier ones). */
const EXTENSION_UNAVAILABLE: ReadonlyArray<string> = ["0A000", "58P01"]
const INSUFFICIENT_PRIVILEGE = "42501"
/** Class 42, syntax error or access rule violation: during the layout step, an object that conflicts or is missing. */
const ACCESS_RULE_CLASS = "42"

const missingExtensionMessage = "the PostgreSQL server does not have the pgvector extension installed: install pgvector on the server, then open the store again"

/** What each step reads as a misconfiguration, by SQLSTATE: a message naming the cause and what to do, never a value. */
const misconfiguration = (code: string, step: PostgresStep): Option.Option<string> => Match.value(step).pipe(
  Match.when("extension", () => code === INSUFFICIENT_PRIVILEGE
    ? Option.some("the PostgreSQL role may not create the pgvector extension: have a privileged role run CREATE EXTENSION vector in this database, then open the store again")
    : EXTENSION_UNAVAILABLE.includes(code) ? Option.some(missingExtensionMessage) : Option.none()),
  Match.when("layout", () => code === INSUFFICIENT_PRIVILEGE
    ? Option.some("the PostgreSQL role may not migrate the efferent_knowledge schema: grant it CREATE on the database and on that schema, and read and write access to its tables")
    : code.startsWith(ACCESS_RULE_CLASS) || EXTENSION_UNAVAILABLE.includes(code)
      ? Option.some("the database does not fit the knowledge store's layout: an object in the efferent_knowledge schema conflicts with it, or the vector type is not on the role's search path")
      : Option.none()),
  Match.when("query", () => code === INSUFFICIENT_PRIVILEGE
    ? Option.some("the PostgreSQL role lacks a privilege on the efferent_knowledge schema or its tables: grant it usage of the schema and read and write access to its tables")
    : Option.none()),
  Match.exhaustive,
)

/**
 * The one mapping of a PostgreSQL driver failure to a `KnowledgeError`, by its SQLSTATE and the
 * step it happened in. A concurrent write is `Conflict`; a misconfiguration that waiting does not
 * fix (a missing or uncreatable pgvector extension, a missing privilege, a database whose objects
 * do not fit the layout) is `Invalid`; everything else, connection failures and deadlines
 * included, stays `Unavailable`, which a caller may retry. Messages never carry the connection
 * string or a value; the driver's error stays in `cause`.
 */
export const postgresFailure = (cause: unknown, step: PostgresStep): KnowledgeError => {
  const code = Option.getOrElse(errorCodeOf(cause), () => "")
  return CONFLICTS.includes(code)
    ? new KnowledgeError({ reason: "Conflict", message: "the knowledge store changed concurrently", cause })
    : Option.match(misconfiguration(code, step), {
      onSome: (message) => new KnowledgeError({ reason: "Invalid", message, cause }),
      onNone: () => new KnowledgeError({ reason: "Unavailable", message: "the PostgreSQL knowledge store is unavailable", cause }),
    })
}

/** The migration's refusal when the extension probe finds pgvector neither installed in the database nor available on the server. */
export const missingVectorExtension = (): KnowledgeError => new KnowledgeError({ reason: "Invalid", message: missingExtensionMessage })
