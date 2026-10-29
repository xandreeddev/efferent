import { Schema } from "effect"

export const parsed = JSON.parse("{}") as unknown
export const parse: (text: string) => unknown = JSON.parse
export const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))("{}")
export const text = JSON.stringify({ a: 1 })
