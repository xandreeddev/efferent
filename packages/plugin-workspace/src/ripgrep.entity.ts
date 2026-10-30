import { Schema } from "effect"

/** ripgrep represents non-UTF-8 paths and lines as base64 bytes. */
export const RgText = Schema.Union([Schema.Struct({ text: Schema.String }), Schema.Struct({ bytes: Schema.StringFromBase64 })])
export type RgText = typeof RgText.Type

const line = Schema.Struct({ path: RgText, lines: RgText, line_number: Schema.Int.check(Schema.isGreaterThan(0)) })

/** Only the fields the workspace search consumes from ripgrep's JSON stream. */
export const RgMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("begin"), data: Schema.Struct({ path: RgText }) }),
  Schema.Struct({ type: Schema.Literal("match"), data: line }),
  Schema.Struct({ type: Schema.Literal("context"), data: line }),
  Schema.Struct({ type: Schema.Literal("end"), data: Schema.Struct({ path: RgText, binary_offset: Schema.NullOr(Schema.Int) }) }),
  Schema.Struct({ type: Schema.Literal("summary"), data: Schema.Struct({}) }),
]).pipe(Schema.toTaggedUnion("type"))
export type RgMessage = typeof RgMessage.Type
