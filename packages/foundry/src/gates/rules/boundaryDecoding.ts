import * as ts from "typescript"
import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule } from "../idiomGate.js"
import { isMemberOf, matchesIn } from "./syntax.js"

/** `JSON.parse` returns `any`: whatever the text held flows on unchecked,
 *  and malformed text throws. A Schema decodes the text and the shape in
 *  one step and fails as a value. */
export const noJsonParse: IdiomRule = {
  id: RuleId.make("effect/no-json-parse"),
  defaultSeverity: "error",
  description: "JSON text is decoded with a Schema, never `JSON.parse`",
  fixHint:
    "decode with `Schema.decodeUnknownEffect(Schema.fromJsonString(S))` (`decodeUnknownResult`/`decodeUnknownOption` in pure code); `Schema.fromJsonString(Schema.Unknown)` when the shape is open",
  check: ({ sourceFile }) =>
    matchesIn(sourceFile, (node) =>
      isMemberOf(node, "JSON", ["parse"])
        ? [{ node, message: "`JSON.parse` yields an unchecked value and throws on malformed text" }]
        : [],
    ),
}

const SYNC_CODECS = ["decodeSync", "decodeUnknownSync", "encodeSync", "encodeUnknownSync"]

/** The `*Sync` codecs throw a `SchemaError` instead of returning it: the
 *  failure leaves the type and becomes a defect wherever it is called. */
export const noSyncCodec: IdiomRule = {
  id: RuleId.make("effect/no-sync-codec"),
  defaultSeverity: "error",
  description: "Schema codecs return their failure; the throwing `*Sync` forms are banned",
  fixHint:
    "use the Effect form (`decodeUnknownEffect`/`encodeEffect`), the Result form (`decodeUnknownResult`/`encodeResult`) or the Option form (`decodeUnknownOption`), and handle the failure",
  check: ({ sourceFile }) =>
    matchesIn(sourceFile, (node) =>
      ts.isPropertyAccessExpression(node) && SYNC_CODECS.includes(node.name.text)
        ? [{ node, message: `\`${node.name.text}\` throws when the value does not ${node.name.text.startsWith("decode") ? "decode" : "encode"}` }]
        : [],
    ),
}
