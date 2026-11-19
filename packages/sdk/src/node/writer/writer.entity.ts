import { Schema } from "effect"

/**
 * Who holds a store as its writer: the process, the machine it runs on (its
 * host name), a token the holder drew when it took the store, and when it
 * took it, in milliseconds since the epoch. A lock file holds one, written
 * whole before the file is published, so a lock file is never read half
 * written.
 */
export const Holder = Schema.Struct({
  pid: Schema.Int,
  host: Schema.String,
  token: Schema.String,
  since: Schema.Number,
})
export type Holder = typeof Holder.Type

/**
 * Why a durable journal did not open: another process holds the store
 * (`Held`), what is at the path is no store of this release's (`Format`: a
 * layout or schema it does not read, or files and data that are not a
 * journal store's), or the medium could not be reached or written
 * (`Unavailable`).
 *
 * @public
 */
export const OpenRefusal = Schema.Literals(["Held", "Format", "Unavailable"])
export type OpenRefusal = typeof OpenRefusal.Type

/**
 * A durable journal that did not open, and why: the layer of `directoryJournal`
 * or `sqliteJournal` fails with it, so nothing is built over a store this
 * process may not write. `store` is the path the host gave.
 *
 * @public
 */
export class JournalOpenFailed extends Schema.TaggedError<JournalOpenFailed>()("JournalOpenFailed", {
  reason: OpenRefusal,
  store: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The holder file with the highest number in a store's writer folder, as it was read: none, a holder, or a file that does not decode. */
export type Found =
  | { readonly _tag: "None" }
  | { readonly _tag: "Holding"; readonly number: number; readonly holder: Holder }
  | { readonly _tag: "Unreadable"; readonly number: number }

/** What a process that opens a store does about what it found: take the store under the next number, or leave it to its holder. */
export type Verdict =
  | { readonly _tag: "Take"; readonly number: number }
  | { readonly _tag: "Held"; readonly why: string }

/** A process as a holder names it: its id and its machine's name. */
export interface ThisProcess {
  readonly pid: number
  readonly host: string
}
