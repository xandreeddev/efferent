import { Schema } from "effect"

const raw: unknown = { id: "a" }
export const Meta = Schema.Record(Schema.String, Schema.Unknown)
export const shaped = raw as { readonly id: string }
