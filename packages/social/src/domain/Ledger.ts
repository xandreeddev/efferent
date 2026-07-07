import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect, Schema } from "effect"

/**
 * The append-only engagement ledger — the social agent's durable memory and
 * the substrate every policy gate reads. One JSONL row per lifecycle event;
 * rows are NEVER edited or deleted (an outcome is a new row). Dedup consults
 * THIS, not directory names: a discarded draft's target stays engaged-once
 * forever, a posted reply can never be replied to again.
 */
export class LedgerEntry extends Schema.Class<LedgerEntry>("LedgerEntry")({
  at: Schema.String.annotations({ description: "ISO timestamp of the event." }),
  event: Schema.Literal("drafted", "gate_rejected", "queued", "posted", "discarded", "skipped"),
  kind: Schema.Literal("reply", "post"),
  /** The engaged tweet (replies) — the dedup key. Absent for standalone posts. */
  targetTweetId: Schema.optional(Schema.String),
  targetAuthor: Schema.optional(Schema.String),
  referenceBlogSlug: Schema.optional(Schema.String),
  /** The draft body at the moment of the event (posted rows carry what went out). */
  content: Schema.optional(Schema.String),
  /** gate_rejected rows: the findings, one line each. */
  findings: Schema.optional(Schema.Array(Schema.String)),
  /** The draft file this event concerns, when one exists. */
  filename: Schema.optional(Schema.String),
}) {}

const decodeEntry = Schema.decodeUnknownEither(LedgerEntry)

export class LedgerError extends Schema.TaggedError<LedgerError>()("LedgerError", {
  message: Schema.String,
}) {}

/** Append one row (creates the file + parents on first write). */
export const appendLedger = (
  path: string,
  entry: LedgerEntry,
): Effect.Effect<void, LedgerError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8")
    },
    catch: (e) => new LedgerError({ message: `ledger append failed: ${String(e)}` }),
  })

/** Every decodable row, oldest first. A missing file is an empty ledger; a
 *  corrupt LINE is skipped (the ledger is append-only — one bad row must not
 *  brick every gate), but decodable history always loads. */
export const readLedger = (path: string): Effect.Effect<ReadonlyArray<LedgerEntry>> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf-8"),
    catch: () => "missing" as const,
  }).pipe(
    Effect.map((text) =>
      text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          const parsed = Effect.runSync(
            Effect.try({ try: () => JSON.parse(line) as unknown, catch: () => undefined }).pipe(
              Effect.orElseSucceed(() => undefined),
            ),
          )
          if (parsed === undefined) return []
          const decoded = decodeEntry(parsed)
          return decoded._tag === "Right" ? [decoded.right] : []
        }),
    ),
    Effect.orElseSucceed(() => []),
  )

/* ------------------------------------------------------------------ */
/* Pure ledger views the gates read                                    */
/* ------------------------------------------------------------------ */

/** Tweet ids we ever ENGAGED (drafted/queued/posted — a discard still counts
 *  as engaged-once: never re-draft a target a human already rejected). */
export const engagedTweetIds = (entries: ReadonlyArray<LedgerEntry>): ReadonlySet<string> =>
  new Set(
    entries
      .filter((e) => e.targetTweetId !== undefined && e.event !== "skipped")
      .map((e) => e.targetTweetId as string),
  )

/** Posted rows inside the window ending at `now`. */
export const postedInWindow = (
  entries: ReadonlyArray<LedgerEntry>,
  now: Date,
  windowMs: number,
): ReadonlyArray<LedgerEntry> =>
  entries.filter(
    (e) => e.event === "posted" && now.getTime() - Date.parse(e.at) < windowMs,
  )

/** Posted rows engaging one author (case-insensitive handle match). */
export const postedToAuthor = (
  entries: ReadonlyArray<LedgerEntry>,
  author: string,
): ReadonlyArray<LedgerEntry> =>
  entries.filter(
    (e) =>
      e.event === "posted" &&
      e.targetAuthor !== undefined &&
      e.targetAuthor.toLowerCase() === author.toLowerCase(),
  )
