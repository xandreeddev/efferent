import { SqlClient } from "@effect/sql"
import { Effect, Layer, Schema } from "effect"

import {
  Capture,
  CaptureAmbiguous,
  CaptureNotFound,
  CaptureStore,
  CaptureStoreError,
} from "@agent/core"

interface CaptureRow {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly source: string | null
  readonly created_at: bigint | number
}

const decodeRow = (row: CaptureRow) =>
  Schema.decodeUnknown(Capture)({
    id: row.id,
    title: row.title,
    body: row.body,
    source: row.source,
    createdAt: Number(row.created_at),
  })

const wrapSql = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
  message: string,
) =>
  effect.pipe(
    Effect.mapError((cause) => new CaptureStoreError({ cause, message })),
  )

const lookupByIdOrPrefix = (sql: SqlClient.SqlClient, idOrPrefix: string) =>
  Effect.gen(function* () {
    const rows = yield* wrapSql(
      idOrPrefix.length === 36
        ? sql<CaptureRow>`SELECT id::text, title, body, source, created_at FROM captures WHERE id = ${idOrPrefix}::uuid`
        : sql<CaptureRow>`SELECT id::text, title, body, source, created_at FROM captures WHERE id::text LIKE ${idOrPrefix + "%"}`,
      "Failed to look up capture",
    )
    if (rows.length === 0) {
      return yield* Effect.fail(new CaptureNotFound({ id: idOrPrefix }))
    }
    if (rows.length > 1) {
      return yield* Effect.fail(
        new CaptureAmbiguous({ prefix: idOrPrefix, matches: rows.length }),
      )
    }
    return rows[0]!
  })

export const PostgresCaptureStoreLive = Layer.effect(
  CaptureStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return CaptureStore.of({
      save: ({ title, body, source }) =>
        Effect.gen(function* () {
          const id = crypto.randomUUID()
          const createdAt = Date.now()
          yield* wrapSql(
            sql`INSERT INTO captures (id, title, body, source, created_at)
                VALUES (${id}::uuid, ${title}, ${body}, ${source}, ${createdAt})`,
            "Failed to insert capture",
          )
          return yield* Schema.decodeUnknown(Capture)({
            id,
            title,
            body,
            source,
            createdAt,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new CaptureStoreError({
                  cause,
                  message: "Inserted row failed Capture schema validation",
                }),
            ),
          )
        }),

      list: () =>
        Effect.gen(function* () {
          const rows = yield* wrapSql(
            sql<CaptureRow>`SELECT id::text, title, body, source, created_at FROM captures ORDER BY created_at DESC LIMIT 100`,
            "Failed to list captures",
          )
          return yield* Effect.forEach(rows, (row) =>
            decodeRow(row).pipe(
              Effect.mapError(
                (cause) =>
                  new CaptureStoreError({
                    cause,
                    message: "Row failed Capture schema validation",
                  }),
              ),
            ),
          )
        }),

      get: (idOrPrefix) =>
        lookupByIdOrPrefix(sql, idOrPrefix).pipe(
          Effect.flatMap((row) =>
            decodeRow(row).pipe(
              Effect.mapError(
                (cause) =>
                  new CaptureStoreError({
                    cause,
                    message: "Row failed Capture schema validation",
                  }),
              ),
            ),
          ),
        ),

      delete: (idOrPrefix) =>
        Effect.gen(function* () {
          const row = yield* lookupByIdOrPrefix(sql, idOrPrefix)
          yield* wrapSql(
            sql`DELETE FROM captures WHERE id = ${row.id}::uuid`,
            "Failed to delete capture",
          )
        }),
    })
  }),
)
