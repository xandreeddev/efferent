import { Effect, Schema } from "effect"

/**
 * A detached JSON copy of `input`, read as JSON text would carry it: keys whose
 * value is `undefined` are left out and `toJSON` gives a value its JSON form (a
 * `Date` its ISO string), as when a provider sends the same object. A value JSON
 * cannot encode (a BigInt, a cycle, `undefined` alone) fails. Authored codecs
 * decode such a copy, never a caller's object or stored evidence.
 */
export const jsonTextCopy = (input: unknown): Effect.Effect<Schema.Json, Schema.SchemaError> =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(input).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))),
  )
