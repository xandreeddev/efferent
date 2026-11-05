import { expect, test } from "bun:test"
import { Effect, Redacted } from "effect"
import { knowledgePostgresDefaults, VECTOR_EXTENSION } from "./knowledge-postgres.entity.js"
import { extensionAvailable, makePostgresDatabase, migratePostgres } from "./postgres-connection.adapter.js"

const url = process.env.EFFERENT_TEST_POSTGRES_URL ?? ""
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const open = makePostgresDatabase(Redacted.make(url), knowledgePostgresDefaults)
const ABSENT = "efferent_absent_extension_probe"

test.skipIf(url.length === 0)("the extension probe finds pgvector and not an extension the server lacks", () => run(Effect.scoped(Effect.gen(function* () {
  const database = yield* open
  yield* migratePostgres(database)
  expect(yield* extensionAvailable(database, VECTOR_EXTENSION)).toBe(true)
  expect(yield* extensionAvailable(database, ABSENT)).toBe(false)
}))))

test.skipIf(url.length === 0)("the server's refusal of an extension it lacks reads as a missing extension, not an outage", () => run(Effect.scoped(Effect.gen(function* () {
  const database = yield* open
  const error = yield* database.transaction((tx) => tx.at("extension").execute(`CREATE EXTENSION IF NOT EXISTS ${ABSENT}`)).pipe(Effect.flip)
  expect(error.reason).toBe("Invalid")
  expect(error.message).toBe("the PostgreSQL server does not have the pgvector extension installed: install pgvector on the server, then open the store again")
}))))

test("an unreachable server stays unavailable, and its message carries no connection detail", () => run(Effect.scoped(Effect.gen(function* () {
  const database = yield* makePostgresDatabase(Redacted.make("postgres://probe:secret-password@127.0.0.1:9/absent"), { ...knowledgePostgresDefaults, connectTimeoutSeconds: 2 })
  const error = yield* migratePostgres(database).pipe(Effect.flip)
  expect(error.reason).toBe("Unavailable")
  expect(error.message).toBe("the PostgreSQL knowledge store is unavailable")
}))))
