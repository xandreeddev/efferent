import { Schema } from "effect"

/**
 * The schema of a journal database this release reads and writes, kept in
 * its `PRAGMA user_version`: `sessions` (each session's id and its header as
 * JSON) and `events` (each event as JSON, by its session and place). A
 * database at any other schema is refused (`Format`), never read, written or
 * migrated.
 *
 * @public
 */
export const SQLITE_SCHEMA = 1

/**
 * What a journal database says it is, in `PRAGMA application_id`: the four
 * letters `EfKJ` as one number. A database whose tables are some other
 * application's is refused (`Format`).
 *
 * @public
 */
export const SQLITE_APPLICATION_ID = 0x45664b4a

/**
 * How the SQLite journal is set up.
 *
 * @public
 */
export interface SqliteJournalOptions {
  /** The database file: made with its folder when it is not there; one of another schema or application is refused. */
  readonly path: string
}

/** The header of the database, as `PRAGMA user_version` and `PRAGMA application_id` and its tables say. */
export const DatabaseHeader = Schema.Struct({ version: Schema.Int, application: Schema.Int, tables: Schema.Int })
export type DatabaseHeader = typeof DatabaseHeader.Type

/** A `sessions` row as it is read. */
export const SessionRow = Schema.Struct({ header: Schema.String })
/** An `events` row as it is read. */
export const EventRow = Schema.Struct({ seq: Schema.Int, event: Schema.String })
/** What `max(seq)` gives: none for a session with no events. */
export const LastRow = Schema.Struct({ last: Schema.NullOr(Schema.Int) })
