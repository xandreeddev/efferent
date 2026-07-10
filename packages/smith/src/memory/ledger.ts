import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Effect, Schema } from "effect"
import { decodeJsonLines } from "@xandreed/engine"
import { MemoryEvent } from "./domain.js"

/**
 * The memory ledger — append-only JSONL at `.efferent/memory/ledger.jsonl`
 * (the social package's Ledger discipline): rows are never edited or
 * deleted, a corrupt LINE is skipped on read (one bad row must not brick
 * the workspace's memory), and the file is plain text the human can always
 * inspect, edit, or delete.
 */

export const memoryLedgerPath = (cwd: string): string =>
  join(cwd, ".efferent", "memory", "ledger.jsonl")

export class MemoryLedgerError extends Schema.TaggedError<MemoryLedgerError>()(
  "MemoryLedgerError",
  { message: Schema.String },
) {}

const encodeEvent = Schema.encodeSync(MemoryEvent)
const decodeEvent = Schema.decodeUnknownEither(MemoryEvent)

/** Append a batch of verb rows (creates the file + parents on first write). */
export const appendMemoryEvents = (
  path: string,
  events: ReadonlyArray<MemoryEvent>,
): Effect.Effect<void, MemoryLedgerError> =>
  events.length === 0
    ? Effect.void
    : Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true })
          await appendFile(
            path,
            `${events.map((event) => JSON.stringify(encodeEvent(event))).join("\n")}\n`,
            "utf-8",
          )
        },
        catch: (e) => new MemoryLedgerError({ message: `memory append failed: ${String(e)}` }),
      })

/** Every decodable row, oldest first; missing file = empty memory. */
export const readMemoryLedger = (
  path: string,
): Effect.Effect<ReadonlyArray<MemoryEvent>> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf-8"),
    catch: () => "missing" as const,
  }).pipe(
    Effect.map((text) => decodeJsonLines(text, decodeEvent)),
    Effect.orElseSucceed(() => []),
  )
