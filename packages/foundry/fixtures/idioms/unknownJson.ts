import { Schema } from "effect"

export const Meta = Schema.Record(Schema.String, Schema.Unknown)
export const decodeOpen = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
export const Nested = Schema.Struct({ meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) })
export const toText = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
export const encodeMeta = Schema.encodeResult(Schema.Record(Schema.String, Schema.Unknown))
export const Input = Schema.Struct({ input: Schema.Unknown, items: Schema.Array(Schema.Unknown) })
export const Labels = Schema.Record(Schema.String, Schema.String)
export const fromText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject))
