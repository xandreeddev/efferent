import { Schema } from "effect"
import { ModelRequestHeader } from "./model-request.entity.js"
import { RequestPartHash } from "./request-part.entity.js"

/** A stored request header whose system and ordered tool declarations reference preceding parts. @public */
export const ModelRequestHeaderV2 = Schema.Struct({
  ...ModelRequestHeader.fields,
  version: Schema.Literal(2),
  system: RequestPartHash,
  tools: Schema.Array(RequestPartHash),
})
export type ModelRequestHeaderV2 = typeof ModelRequestHeaderV2.Type

/** Both durable header versions; public replay materializes either as `ModelRequestHeader`. @public */
export const StoredModelRequestHeader = Schema.Union([ModelRequestHeader, ModelRequestHeaderV2])
export type StoredModelRequestHeader = typeof StoredModelRequestHeader.Type
