import { Option, Order, Result, Schema } from "effect"
import type { SessionHead, SessionListQuery } from "@xandreed/core"
import { CommitEvent, CommitMeta, CommitState, CommitTrailer, HeaderRecord, StoreMarker } from "./session-files.entity.js"
import type { CommitDamage, CommitRecord, StoreHealth, TailVerdict } from "./session-files.entity.js"

/* ── CRC-32 (IEEE 802.3), over bytes ── */

const CRC_TABLE: ReadonlyArray<number> = Array.from({ length: 256 }, (_, n) =>
  Array.from({ length: 8 }).reduce<number>((c) => (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1, n))

/** The CRC-32 of `bytes`, as eight lowercase hex digits. */
export const crc32Of = (bytes: Uint8Array): string =>
  ((bytes.reduce((crc, byte) => (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0")

/* ── names ── */

const REVISION_DIGITS = 12

/** A commit file's name: its revision, padded so names sort as numbers do. */
export const revisionFile = (revision: number): string => `${String(revision).padStart(REVISION_DIGITS, "0")}.jsonl`

/** The revision a commit file's name holds; none for any other name (a temporary file, a stray one). */
export const revisionOfFile = (name: string): Option.Option<number> => {
  const match = /^(\d{12})\.jsonl$/.exec(name)
  return match === null ? Option.none() : Option.some(Number(match[1]))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether a name under `sessions/` is a session's directory: its id. Anything else (an editor's file, a network file system's `.nfs…`) is not read. */
export const isSessionDirectory = (name: string): boolean => UUID.test(name)

/* ── records ── */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The lines of a commit file, as its bytes: meta, state, one line per event, then the trailer over the bytes before it. */
export const encodeCommit = (record: CommitRecord): Uint8Array => {
  const body = encoder.encode([
    JSON.stringify(record.meta),
    JSON.stringify({ state: record.state }),
    ...record.events.map((event) => JSON.stringify(event)),
  ].map((line) => `${line}\n`).join(""))
  const trailer = encoder.encode(`${JSON.stringify({ bytes: body.length, crc32: crc32Of(body) })}\n`)
  const file = new Uint8Array(body.length + trailer.length)
  file.set(body)
  file.set(trailer, body.length)
  return file
}

const decodeMetaLine = Schema.decodeUnknownResult(Schema.fromJsonString(CommitMeta))
const decodeStateLine = Schema.decodeUnknownResult(Schema.fromJsonString(CommitState))
const decodeEventLine = Schema.decodeUnknownResult(Schema.fromJsonString(CommitEvent))
const decodeTrailerLine = Schema.decodeUnknownResult(Schema.fromJsonString(CommitTrailer))

/**
 * A commit file's bytes as the commit: whole (its trailer's length and
 * CRC-32 match the bytes before it) and decoded line by line, or what is
 * wrong with it: cut short (no trailer, or one that counts other bytes),
 * changed (the checksum), or lines that do not decode.
 */
export const decodeCommit = (bytes: Uint8Array): Result.Result<CommitRecord, CommitDamage> => {
  const end = bytes.length > 0 && bytes[bytes.length - 1] === 10 ? bytes.length - 1 : -1
  if (end < 0) return Result.fail("short")
  const trailerStart = bytes.lastIndexOf(10, end - 1) + 1
  const trailer = decodeTrailerLine(decoder.decode(bytes.subarray(trailerStart, end)))
  if (Result.isFailure(trailer) || trailer.success.bytes !== trailerStart) return Result.fail("short")
  const body = bytes.subarray(0, trailerStart)
  if (crc32Of(body) !== trailer.success.crc32) return Result.fail("checksum")
  const [metaLine = "", stateLine = "", ...eventLines] = decoder.decode(body).split("\n").slice(0, -1)
  const meta = decodeMetaLine(metaLine)
  const state = decodeStateLine(stateLine)
  const events = eventLines.map((line) => decodeEventLine(line))
  if (Result.isFailure(meta) || Result.isFailure(state) || events.some(Result.isFailure)) return Result.fail("decode")
  return Result.succeed({ meta: meta.success, state: state.success.state, events: events.flatMap((event) => Result.isSuccess(event) ? [event.success] : []) })
}

/** A commit file's first line, read alone (a read that skips the commit needs nothing else); none when it is not one. */
export const metaOfLine = (line: string): Option.Option<CommitMeta> => Result.getSuccess(decodeMetaLine(line))

/** What to do with a commit file that is not whole: a tail is set aside; anything before the tail is damage the store does not repair. */
export const tailVerdict = (decoded: Result.Result<CommitRecord, CommitDamage>, isTail: boolean): TailVerdict =>
  Result.match(decoded, {
    onSuccess: (): TailVerdict => ({ _tag: "Intact" }),
    onFailure: (damage): TailVerdict => isTail ? { _tag: "Quarantine", damage } : { _tag: "Corrupt", damage },
  })

const encodeHeader = Schema.encodeUnknownResult(Schema.fromJsonString(HeaderRecord))
const decodeHeaderText = Schema.decodeUnknownResult(Schema.fromJsonString(HeaderRecord))
const decodeMarkerText = Schema.decodeUnknownResult(Schema.fromJsonString(StoreMarker))

/** `header.json` as text. */
export const headerText = (record: HeaderRecord): Result.Result<string, Schema.SchemaError> => encodeHeader(record)

/** `header.json`'s text as its record. */
export const headerOfText = (text: string): Result.Result<HeaderRecord, Schema.SchemaError> => decodeHeaderText(text)

/** `store.json`'s text as its marker. */
export const markerOfText = (text: string): Result.Result<StoreMarker, Schema.SchemaError> => decodeMarkerText(text)

/* ── listing ── */

/** Most recently updated first, then by id, descending: the listing's order. */
export const newestFirst: Order.Order<SessionHead> = Order.combine(
  Order.flip(Order.mapInput(Order.Number, (head: SessionHead) => head.updatedAt)),
  Order.flip(Order.mapInput(Order.String, (head: SessionHead) => head.header.id)),
)

/** Whether a session's header puts it in a listing: the owner's, top-level or the named parent's child. */
export const inListing = (record: HeaderRecord, query: SessionListQuery): boolean =>
  record.header.owner === query.owner && Option.match(query.parent, {
    onNone: () => Option.isNone(record.header.parent),
    onSome: (parent) => Option.exists(record.header.parent, (lineage) => lineage.id === parent),
  })

/** The heads strictly older than the listing's cursor, in order, at most its limit. */
export const page = (heads: ReadonlyArray<SessionHead>, query: SessionListQuery): ReadonlyArray<SessionHead> =>
  [...heads].sort(newestFirst).filter((head) => Option.match(query.before, {
    onNone: () => true,
    onSome: (cursor) => head.updatedAt < cursor.updatedAt || (head.updatedAt === cursor.updatedAt && head.header.id < cursor.id),
  })).slice(0, Math.max(0, query.limit))

/* ── health ── */

/** Whether a call goes through: always while healthy; while stalled, one call at a time once `stallMs` passed since the stall (the probe). */
export const admitCall = (health: StoreHealth, now: number, stallMs: number): readonly [boolean, StoreHealth] =>
  health._tag === "Healthy"
    ? [true, health]
    : !health.probing && now - health.since >= stallMs
      ? [true, { ...health, probing: true }]
      : [false, health]

/** A call's outcome on the store's health: one that answered heals it; one that stalled marks it stalled from now. */
export const afterCall = (health: StoreHealth, answered: boolean, now: number): StoreHealth =>
  answered ? { _tag: "Healthy" } : { _tag: "Stalled", since: now, probing: false }
