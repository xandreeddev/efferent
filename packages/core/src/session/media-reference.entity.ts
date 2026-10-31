import { Schema } from "effect"
import { MediaHash } from "../domain/media-store.entity.js"

/** Physical media bytes referenced only through a framework payload manifest. @public */
export const MediaReference = Schema.StructWithRest(Schema.Struct({
  type: Schema.Literal("media-reference"), version: Schema.Literal(1), hash: MediaHash,
}), [Schema.Record(Schema.String, Schema.Json)]).check(Schema.makeFilter((value) => Object.keys(value).length === 3 || "a media reference has exactly type, version and hash"))
export type MediaReference = typeof MediaReference.Type

export const MediaDataPath = Schema.Array(Schema.Union([Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))])).check(
  Schema.isMinLength(1), Schema.makeFilter((path) => path[path.length - 1] === "data" || "a media path ends at data"),
)
export type MediaDataPath = typeof MediaDataPath.Type

const MediaPayload = Schema.StructWithRest(Schema.Struct({
  version: Schema.Literal(1), value: Schema.JsonObject, paths: Schema.Array(MediaDataPath),
}), [Schema.Record(Schema.String, Schema.Json)]).check(
  Schema.makeFilter((value) => Object.keys(value).length === 3 || "a media payload has exactly version, value and paths"),
  Schema.makeFilter(({ paths }) => paths.every((path, index) => paths.every((other, otherIndex) => index === otherIndex
    || !(path.length <= other.length && path.every((key, at) => key === other[at])))) || "media paths are unique and do not overlap"),
)

/** Exact physical root envelope; ordinary nested lookalikes remain literal JSON. @public */
export const MediaEnvelope = Schema.StructWithRest(Schema.Struct({
  "$efferent.media": MediaPayload,
}), [Schema.Record(Schema.String, Schema.Json)]).check(Schema.makeFilter((value) => Object.keys(value).length === 1 || "a media envelope has one own key"))
export type MediaEnvelope = typeof MediaEnvelope.Type

export const MediaCacheOptions = Schema.Struct({
  cacheEntries: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
  cacheBytes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
})
