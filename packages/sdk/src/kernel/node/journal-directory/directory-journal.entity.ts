import { Schema } from "effect"

/**
 * What a journal directory says it is, in `store.json`: whose store it is
 * (`DIRECTORY_STORE`) and the layout of its files (`DIRECTORY_LAYOUT`). A
 * directory whose marker says anything else is refused (`Format`), never
 * read or written: there is no migration.
 *
 * @public
 */
export const DirectoryMarker = Schema.Struct({ store: Schema.String, layout: Schema.Int })
export type DirectoryMarker = typeof DirectoryMarker.Type

/** @public */
export const DIRECTORY_STORE = "efferent.kernel.journal-directory"

/**
 * The layout of a journal directory this release reads and writes:
 * `store.json`; `writer/`, the holder of the store; `sessions/<name>.jsonl`, one
 * file per session, its header on the first line and an event on each line
 * after it, each line its CRC-32 and its JSON; and `tmp/`, where a new file is
 * written whole before it is published.
 *
 * @public
 */
export const DIRECTORY_LAYOUT = 1

/**
 * How the directory journal is set up.
 *
 * @public
 */
export interface DirectoryJournalOptions {
  /** The directory: made when it is not there; an empty one becomes a store; one that holds other files is refused. */
  readonly directory: string
}

/** Where a session file stops being one: the number of its first line that is not whole. */
export interface LineDamage {
  readonly line: number
}

/**
 * A session file's lines as they were read: the JSON of each whole line, in
 * order, and the bytes they take. Bytes after the last line break are a line
 * a write left unfinished (a torn tail): they are not among the lines.
 */
export interface SessionLines {
  readonly lines: ReadonlyArray<string>
  readonly whole: number
}
