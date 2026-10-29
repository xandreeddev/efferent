import { Effect, Schema } from "effect"
import { JsonObject } from "./session-log.entity.js"

const JsonObjectText = Schema.fromJsonString(JsonObject)
const encodeText = Schema.encodeEffect(JsonObjectText)
const decodeText = Schema.decodeUnknownEffect(JsonObjectText)

/**
 * A JSON object as a store gives it back: written as JSON text and read
 * again. It is a copy, with `undefined` fields dropped, so a log in memory
 * returns from a commit what a later read (or a store on disk) does. A
 * value JSON cannot hold (a BigInt, a cycle) fails with the SchemaError.
 */
export const storedJson = (value: JsonObject): Effect.Effect<JsonObject, Schema.SchemaError> =>
  encodeText(value).pipe(Effect.flatMap(decodeText))
