import { Effect, Option, Schema } from "effect"
import { Media } from "../domain/media.entity.js"
import { normalizeMedia } from "../domain/media.entity.functions.js"
import type { MediaHash } from "../domain/media-store.entity.js"
import type { MediaDataPath } from "./media-reference.entity.js"

export const isJsonObject = Schema.is(Schema.JsonObject)
const coreFields = ["type", "data", "mediaType", "fingerprint", "bytes", "name", "alt"] as const

/** Eligibility is a comparison only: keep original metadata and opaque extras. */
export const canonicalMediaBytes = Effect.fnUntraced(function* (value: Schema.JsonObject): Effect.fn.Return<Option.Option<Uint8Array>> {
  const media = Schema.decodeUnknownOption(Media)(value)
  if (Option.isNone(media)) return Option.none()
  const normalized = yield* normalizeMedia(media.value).pipe(Effect.result)
  if (normalized._tag === "Failure" || !coreFields.every((key) => normalized.success[key] === value[key])) return Option.none()
  return Schema.decodeUnknownOption(Schema.Uint8ArrayFromBase64)(media.value.data)
})

/** Only own fields and bounded array indices can be traversed by a manifest. */
export const jsonAt = (root: Schema.Json, path: ReadonlyArray<string | number>): Option.Option<Schema.Json> => path.reduce((found, key) => Option.flatMap(found, (value) => {
  if (Array.isArray(value)) return typeof key === "number" && Number.isSafeInteger(key) && key >= 0 && key < value.length && Object.hasOwn(value, key) ? Option.some(value[key]!) : Option.none()
  return isJsonObject(value) && typeof key === "string" && Object.hasOwn(value, key) ? Option.some(value[key]!) : Option.none()
}), Option.some(root))

/** Rebuild each object safely; special JSON keys never assign a prototype. */
export const replaceJsonAt = (root: Schema.Json, path: MediaDataPath, value: Schema.Json): Option.Option<Schema.Json> => {
  if (path.length === 0) return Option.some(value)
  const key = path[0]!
  const rest = path.slice(1)
  return Option.flatMap(jsonAt(root, [key]), (child) => Option.map(replaceJsonAt(child, rest, value), (replacement) =>
    Array.isArray(root) ? root.map((item, index) => index === key ? replacement : item)
      : isJsonObject(root) ? Object.fromEntries(Object.entries(root).map(([name, item]) => [name, name === key ? replacement : item])) : root))
}

/** Retain the newest entries that fit both independent budgets. */
export const rememberMedia = (cache: ReadonlyMap<MediaHash, Uint8Array>, hash: MediaHash, bytes: Uint8Array, entries: number, budget: number): ReadonlyMap<MediaHash, Uint8Array> => {
  if (entries === 0 || bytes.length > budget) return cache
  const recent = [...cache].filter(([key]) => key !== hash).concat([[hash, new Uint8Array(bytes)]]).slice(-entries)
  const excess = Math.max(0, recent.reduce((sum, [, data]) => sum + data.length, 0) - budget)
  const dropped = recent.reduce((state, [, data]) => state.bytes < excess ? { count: state.count + 1, bytes: state.bytes + data.length } : state, { count: 0, bytes: 0 })
  return new Map(recent.slice(dropped.count))
}
