import { Schema } from "effect"
import { ModelRequestTool } from "./model-request.entity.js"

/** SHA-256 of a canonical, schema-encoded request part. @public */
export const RequestPartHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(Schema.brand("RequestPartHash"))
export type RequestPartHash = typeof RequestPartHash.Type

/** A model request's reusable system text or one tool declaration. @public */
export const RequestPart = Schema.Union([
  Schema.TaggedStruct("System", { text: Schema.String }),
  Schema.TaggedStruct("Tool", { tool: ModelRequestTool }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type RequestPart = typeof RequestPart.Type

/** A durable `request.part`: content and its canonical encoded hash. @public */
export const RequestPartData = Schema.Struct({ hash: RequestPartHash, part: RequestPart })
export type RequestPartData = typeof RequestPartData.Type
