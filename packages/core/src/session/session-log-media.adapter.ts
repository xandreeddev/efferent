import { Array as Arr, Effect, Option, Ref, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { Media } from "../domain/media.entity.js"
import { mediaHashOf } from "../domain/media-store.entity.functions.js"
import type { MediaHash, MediaStoreError } from "../domain/media-store.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import { MediaStore } from "../ports/media-store.port.js"
import type { SessionLog } from "../ports/session-log.port.js"
import { journalSchemaOf } from "./session-event.entity.functions.js"
import { SessionCommit, SessionLogError } from "./session-log.entity.js"
import type { JsonObject, SessionDraft } from "./session-log.entity.js"
import { storedJson } from "./session-log.entity.functions.js"
import { MediaCacheOptions, MediaEnvelope, MediaReference } from "./media-reference.entity.js"
import type { MediaDataPath } from "./media-reference.entity.js"
import { canonicalMediaBytes, isJsonObject, jsonAt, rememberMedia, replaceJsonAt } from "./media-reference.entity.functions.js"

const failed = (code: string, message: string, cause?: unknown) => new SessionLogError({ code, message, ...(cause === undefined ? {} : { cause }) })
const mediaFailure = (operation: "put" | "get", cause: MediaStoreError) => failed(operation === "get" && cause.reason !== "Unavailable" ? "store.decode" : "store.io", `stored media ${operation} failed`, cause)
const logical = (kind: string, data: JsonObject, code: string) => Option.match(journalSchemaOf(kind), {
  onNone: () => Effect.void,
  onSome: (codec) => Schema.decodeUnknownEffect(codec)(data).pipe(Effect.asVoid, Effect.mapError((cause) => failed(code, "framework event data did not decode", cause))),
})
interface EncodedMedia { readonly value: Schema.Json; readonly paths: ReadonlyArray<MediaDataPath> }

/**
 * Store canonical media in known framework event data, preserving hydrated log semantics.
 * Cache bounds default to 32 entries and 32 MiB; either zero disables caching.
 * @public
 */
export const withMediaStore = Effect.fnUntraced(function* (
  inner: SessionLog["Service"], options: { readonly cacheEntries?: number; readonly cacheBytes?: number } = {},
): Effect.fn.Return<SessionLog["Service"], SessionLogError, MediaStore> {
  const config = yield* Schema.decodeUnknownEffect(MediaCacheOptions)(options).pipe(Effect.mapError((cause) => failed("store.encode", "media cache options did not decode", cause)))
  const entries = config.cacheEntries ?? 32
  const budget = config.cacheBytes ?? 32 * 1024 * 1024
  const store = yield* MediaStore
  const cache = yield* Ref.make<ReadonlyMap<MediaHash, Uint8Array>>(new Map())
  const remember = (hash: MediaHash, bytes: Uint8Array) => Ref.update(cache, (all) => rememberMedia(all, hash, bytes, entries, budget))
  const load = Effect.fnUntraced(function* (hash: MediaHash) {
    const hit = yield* Ref.modify(cache, (all) => {
      const bytes = all.get(hash)
      return bytes === undefined ? [Option.none<Uint8Array>(), all] as const
        : [Option.some(new Uint8Array(bytes)), rememberMedia(all, hash, bytes, entries, budget)] as const
    })
    if (Option.isSome(hit)) return hit.value
    const found = yield* store.get(hash).pipe(Effect.mapError((cause) => mediaFailure("get", cause)))
    if (Option.isNone(found)) return yield* Effect.fail(failed("store.decode", "stored media bytes are missing"))
    const bytes = new Uint8Array(found.value)
    if (mediaHashOf(bytes) !== hash) return yield* Effect.fail(failed("store.decode", "stored media bytes do not match their hash"))
    yield* remember(hash, bytes)
    return bytes
  })
  const encodeNode = Effect.fnUntraced(function* (value: Schema.Json, path: ReadonlyArray<string | number>): Effect.fn.Return<EncodedMedia, SessionLogError> {
    if (Array.isArray(value)) {
      const children = yield* Effect.forEach(value, (item, index) => encodeNode(item, [...path, index]), { concurrency: 1 })
      return { value: children.map((child) => child.value), paths: children.flatMap((child) => child.paths) }
    }
    if (!isJsonObject(value)) return { value, paths: [] }
    const bytes = yield* canonicalMediaBytes(value)
    const fields = yield* Effect.forEach(Object.entries(value).filter(([key]) => key !== "data" || Option.isNone(bytes)), ([key, field]) =>
      encodeNode(field, [...path, key]).pipe(Effect.map((child) => ({ key, child }))), { concurrency: 1 })
    const object = Object.fromEntries(fields.map(({ key, child }) => [key, child.value]))
    const paths = fields.flatMap(({ child }) => child.paths)
    if (Option.isNone(bytes)) return { value: object, paths }
    const hash = mediaHashOf(bytes.value)
    const put = yield* store.put(new Uint8Array(bytes.value)).pipe(Effect.mapError((cause) => mediaFailure("put", cause)))
    if (put !== hash) return yield* Effect.fail(failed("store.io", "stored media put returned a different hash"))
    yield* remember(hash, bytes.value)
    const reference: MediaReference = { type: "media-reference", version: 1, hash }
    return { value: { ...object, data: reference }, paths: [...paths, [...path, "data"]] }
  })
  const encodeDraft = Effect.fnUntraced(function* (draft: SessionDraft): Effect.fn.Return<SessionDraft, SessionLogError> {
    if (Option.isNone(journalSchemaOf(draft.kind))) return draft
    const encoded = yield* encodeNode(draft.data, [])
    if (encoded.paths.length === 0) return draft
    if (!isJsonObject(encoded.value)) return yield* Effect.fail(failed("store.encode", "framework media payload is not an object"))
    const envelope: MediaEnvelope = { "$efferent.media": { version: 1, value: encoded.value, paths: encoded.paths } }
    return { ...draft, data: envelope }
  })
  const hydrate = Effect.fnUntraced(function* (kind: string, data: JsonObject): Effect.fn.Return<JsonObject, SessionLogError> {
    if (Option.isNone(journalSchemaOf(kind))) return data
    const envelope = Schema.decodeUnknownOption(MediaEnvelope)(data)
    if (Option.isNone(envelope)) {
      yield* logical(kind, data, "store.decode")
      return data
    }
    const payload = envelope.value["$efferent.media"]
    const value = yield* Effect.reduce(payload.paths, () => payload.value, (current, path) => Effect.gen(function* () {
      const found = yield* Option.match(jsonAt(current, path.slice(0, -1)), { onNone: () => Effect.fail(failed("store.decode", "stored media path is absent")), onSome: Effect.succeed })
      const parent = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(found).pipe(Effect.mapError((cause) => failed("store.decode", "stored media parent is not an object", cause)))
      if (!Object.hasOwn(parent, "data")) return yield* Effect.fail(failed("store.decode", "stored media path has no own data field"))
      const ref = yield* Schema.decodeUnknownEffect(MediaReference)(parent.data).pipe(Effect.mapError((cause) => failed("store.decode", "stored media reference did not decode", cause)))
      yield* Schema.decodeUnknownEffect(Media)({ ...parent, data: "AA==" }).pipe(Effect.mapError((cause) => failed("store.decode", "stored media metadata did not decode", cause)))
      const bytes = yield* load(ref.hash)
      const base64 = Base64.encode(bytes)
      if (Option.isNone(yield* canonicalMediaBytes({ ...parent, data: base64 }))) return yield* Effect.fail(failed("store.decode", "stored media metadata does not match its bytes"))
      const replaced = yield* Option.match(replaceJsonAt(current, path, base64), { onNone: () => Effect.fail(failed("store.decode", "stored media path could not be restored")), onSome: Effect.succeed })
      return yield* Schema.decodeUnknownEffect(Schema.JsonObject)(replaced).pipe(Effect.mapError((cause) => failed("store.decode", "stored media payload did not decode", cause)))
    }))
    yield* logical(kind, value, "store.decode")
    return value
  })
  return {
    ...inner,
    read: Effect.fn("session_log.read_media")(function* (id, query) {
      const found = yield* inner.read(id, query)
      // A backend that ignores the additive bound still cannot cause blob reads
      // for excluded future rows. Snapshot rows before the first asynchronous get.
      const selected = found.filter((event) => query.through === undefined || event.seq <= query.through)
      const copied = yield* Effect.forEach(selected, (event) => storedJson(event.data).pipe(Effect.map((data) => ({ ...event, data })), Effect.mapError((cause) => failed("store.decode", "stored event data is not JSON", cause))), { concurrency: 1 })
      return yield* Effect.forEach(copied, (event) => hydrate(event.kind, event.data).pipe(Effect.map((data) => ({ ...event, data }))), { concurrency: 1 })
    }),
    commit: Effect.fn("session_log.commit_media")(function* (id, input) {
      // Normalize ALL siblings and metadata before the first put can suspend.
      const copied = yield* storedJson({ expect: input.expect, notAfter: Option.getOrElse(input.notAfter, () => null), state: Option.getOrElse(input.state, () => null),
        events: input.events.map((event) => ({ kind: event.kind, turn: Option.getOrElse(event.turn, () => null), data: event.data })) }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SessionCommit)), Effect.mapError((cause) => failed("store.encode", "session commit did not encode", cause)),
      )
      yield* Effect.forEach(copied.events, (draft) => logical(draft.kind, draft.data, "store.encode"), { concurrency: 1, discard: true })
      const drafts = yield* Effect.forEach(copied.events, encodeDraft, { concurrency: 1 })
      // A backend may retain or mutate its input. Compare its ACK to immutable
      // expected bytes captured before calling it, never to that shared input.
      const expectedRows = drafts.map((draft) => ({ kind: draft.kind, turn: Option.getOrElse(draft.turn, () => null), data: canonicalJson(draft.data) }))
      const committed = yield* inner.commit(id, { ...copied, events: drafts })
      if (committed.events.length !== expectedRows.length || committed.events.some((event, index) => {
        const expected = expectedRows[index]!
        return event.session !== id || event.kind !== expected.kind || Option.getOrElse(event.turn, () => null) !== expected.turn || canonicalJson(event.data) !== expected.data
      })) return yield* Effect.fail(failed("store.decode", "committed media rows differ from the submitted physical data"))
      // Original logical snapshots are operation-local, so echo hydration never
      // performs fresh get IO after a successful journal ACK (even with cache0).
      return { ...committed, events: Arr.zip(committed.events, copied.events).map(([event, draft]) => ({ ...event, data: draft.data })) }
    }),
  }
})
