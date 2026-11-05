import { describe, expect, test } from "bun:test"
import postgres from "postgres"
import type { KnowledgeErrorReason } from "@xandreed/core"
import type { PostgresStep } from "./knowledge-postgres.entity.js"
import { missingVectorExtension, postgresFailure } from "./knowledge-postgres.entity.functions.js"

/** A server error as the driver raises it: a `PostgresError` carrying the SQLSTATE in `code`. */
const serverError = (code: string, message: string) => new postgres.PostgresError({ message, code, severity: "ERROR", severity_local: "ERROR" })
/** A connection error as the driver raises it: a plain `Error` with a symbolic `code` and `errno`. */
const connectionError = (code: string) => Object.assign(new Error(`write ${code} 127.0.0.1:5432`), { code, errno: code, address: "127.0.0.1", port: 5432 })

const UNAVAILABLE = "the PostgreSQL knowledge store is unavailable"
const CONFLICT = "the knowledge store changed concurrently"
const MISSING_EXTENSION = "the PostgreSQL server does not have the pgvector extension installed: install pgvector on the server, then open the store again"
const EXTENSION_PRIVILEGE = "the PostgreSQL role may not create the pgvector extension: have a privileged role run CREATE EXTENSION vector in this database, then open the store again"
const LAYOUT_PRIVILEGE = "the PostgreSQL role may not migrate the efferent_knowledge schema: grant it CREATE on the database and on that schema, and read and write access to its tables"
const LAYOUT_MISFIT = "the database does not fit the knowledge store's layout: an object in the efferent_knowledge schema conflicts with it, or the vector type is not on the role's search path"
const QUERY_PRIVILEGE = "the PostgreSQL role lacks a privilege on the efferent_knowledge schema or its tables: grant it usage of the schema and read and write access to its tables"

const STEPS: ReadonlyArray<PostgresStep> = ["query", "extension", "layout"]

describe("postgresFailure", () => {
  // [what the driver raised, the step, the reason, the message]
  const table: ReadonlyArray<readonly [string, unknown, PostgresStep, KnowledgeErrorReason, string]> = [
    ["refused connection", connectionError("ECONNREFUSED"), "query", "Unavailable", UNAVAILABLE],
    ["connect deadline", connectionError("CONNECT_TIMEOUT"), "extension", "Unavailable", UNAVAILABLE],
    ["closed connection", connectionError("CONNECTION_CLOSED"), "layout", "Unavailable", UNAVAILABLE],
    ["connection failure (08006)", serverError("08006", "connection failure"), "layout", "Unavailable", UNAVAILABLE],
    ["server cannot connect now (57P03)", serverError("57P03", "the database system is starting up"), "extension", "Unavailable", UNAVAILABLE],
    ["administrator shutdown (57P01)", serverError("57P01", "terminating connection due to administrator command"), "query", "Unavailable", UNAVAILABLE],
    ["too many connections (53300)", serverError("53300", "sorry, too many clients already"), "query", "Unavailable", UNAVAILABLE],
    ["statement timeout (57014)", serverError("57014", "canceling statement due to statement timeout"), "layout", "Unavailable", UNAVAILABLE],
    ["lock timeout (55P03)", serverError("55P03", "canceling statement due to lock timeout"), "extension", "Unavailable", UNAVAILABLE],
    ["no code at all", new Error("socket hang up"), "query", "Unavailable", UNAVAILABLE],
    ["a thrown string", "boom", "layout", "Unavailable", UNAVAILABLE],
    ["unique violation (23505)", serverError("23505", "duplicate key value violates unique constraint"), "query", "Conflict", CONFLICT],
    ["serialization failure (40001)", serverError("40001", "could not serialize access"), "layout", "Conflict", CONFLICT],
    ["deadlock (40P01)", serverError("40P01", "deadlock detected"), "extension", "Conflict", CONFLICT],
    ["extension not available (0A000, PostgreSQL 15+)", serverError("0A000", "extension \"vector\" is not available"), "extension", "Invalid", MISSING_EXTENSION],
    ["extension control file missing (58P01, before 15)", serverError("58P01", "could not open extension control file"), "extension", "Invalid", MISSING_EXTENSION],
    ["extension needs a superuser (42501)", serverError("42501", "permission denied to create extension \"vector\""), "extension", "Invalid", EXTENSION_PRIVILEGE],
    ["schema creation denied (42501)", serverError("42501", "permission denied for database"), "layout", "Invalid", LAYOUT_PRIVILEGE],
    ["vector type not visible (42704)", serverError("42704", "type \"vector\" does not exist"), "layout", "Invalid", LAYOUT_MISFIT],
    ["conflicting object type (42809)", serverError("42809", "is not a table"), "layout", "Invalid", LAYOUT_MISFIT],
    ["missing column (42703)", serverError("42703", "column does not exist"), "layout", "Invalid", LAYOUT_MISFIT],
    ["table access denied (42501)", serverError("42501", "permission denied for table"), "query", "Invalid", QUERY_PRIVILEGE],
    ["missing column outside migration (42703)", serverError("42703", "column does not exist"), "query", "Unavailable", UNAVAILABLE],
    ["feature not supported outside migration (0A000)", serverError("0A000", "not supported"), "query", "Unavailable", UNAVAILABLE],
    ["undefined file outside migration (58P01)", serverError("58P01", "could not open file"), "query", "Unavailable", UNAVAILABLE],
    ["access rule violation at the extension step (42704)", serverError("42704", "does not exist"), "extension", "Unavailable", UNAVAILABLE],
  ]

  test.each(table)("%s at the %s step", (_name, cause, step, reason, message) => {
    const error = postgresFailure(cause, step)
    expect(error._tag).toBe("KnowledgeError")
    expect(error.reason).toBe(reason)
    expect(error.message).toBe(message)
    expect(error.cause).toBe(cause)
  })

  test("no message carries the connection string, the host or the driver's text", () => {
    const secret = "postgres://admin:hunter2@db.internal:5432/knowledge"
    const causes = [
      Object.assign(connectionError("ECONNREFUSED"), { address: secret }),
      serverError("42501", `permission denied for ${secret}`),
      serverError("0A000", `extension at ${secret}`),
      serverError("42704", `type at ${secret}`),
    ]
    STEPS.forEach((step) => causes.forEach((cause) => {
      const error = postgresFailure(cause, step)
      expect(error.message).not.toContain("hunter2")
      expect(error.message).not.toContain("db.internal")
      expect(error.message).not.toContain("permission denied")
    }))
  })

  test("the extension probe's refusal names the missing extension without a cause", () => {
    const error = missingVectorExtension()
    expect(error.reason).toBe("Invalid")
    expect(error.message).toBe(MISSING_EXTENSION)
    expect(error.cause).toBeUndefined()
  })
})
