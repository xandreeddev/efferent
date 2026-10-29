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
    "decode with `Schema.decodeUnknownEffect(Schema.fromJsonString(S))` (`decodeUnknownResult`/`decodeUnknownOption` in pure code); `Schema.fromJsonString(Schema.Json)` (`Schema.JsonObject` for an object) when the shape is open",
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

/** `Schema.<name>`, `node` absent being no match. */
const isSchema = (node: ts.Node | undefined, name: string): boolean =>
  node !== undefined && isMemberOf(node, "Schema", [name])

/** An argument of a `Schema.encode*` call: writing an open value out as
 *  JSON text trusts nothing (and drops its `undefined` fields). */
const isEncoded = (node: ts.Node): boolean =>
  ts.isCallExpression(node.parent) &&
  node.parent.arguments.some((argument) => argument === node) &&
  ts.isPropertyAccessExpression(node.parent.expression) &&
  node.parent.expression.name.text.startsWith("encode") &&
  isSchema(node.parent.expression, node.parent.expression.name.text)

/** `Schema.Record(Schema.String, Schema.Unknown)` or `Schema.fromJsonString(Schema.Unknown)`. */
const openSchemaMessage = (node: ts.Node): ReadonlyArray<string> =>
  !ts.isCallExpression(node)
    ? []
    : isSchema(node.expression, "Record") && isSchema(node.arguments[0], "String") && isSchema(node.arguments[1], "Unknown")
      ? ["`Schema.Record(Schema.String, Schema.Unknown)` checks the keys and lets every value through"]
      : isSchema(node.expression, "fromJsonString") && isSchema(node.arguments[0], "Unknown")
        ? ["`Schema.fromJsonString(Schema.Unknown)` checks that the text is JSON, not what it holds"]
        : []

/** A schema of unknown values decodes nothing: the reader narrows the value
 *  afterwards by hand (`typeof`, `as`), which is the check the schema was
 *  for. JSON that stays open is `Schema.Json`, which at least refuses what
 *  JSON cannot hold (`undefined`, `NaN`, functions). Encoding is exempt:
 *  `Schema.encode*(Schema.fromJsonString(Schema.Unknown))` writes a value
 *  out without trusting it. */
export const noUnknownJson: IdiomRule = {
  id: RuleId.make("effect/no-unknown-json"),
  defaultSeverity: "error",
  description: "a decoded value has a schema: no `Record(String, Unknown)`, no `fromJsonString(Unknown)`",
  fixHint:
    "decode the shape you read (`Schema.Struct`, `Schema.Record(Schema.String, S)`); `Schema.Json` or `Schema.JsonObject` (`Schema.fromJsonString(Schema.JsonObject)`) for JSON that stays open; writing an open value as text may use `Schema.encode*(Schema.fromJsonString(Schema.Unknown))`",
  check: ({ sourceFile }) =>
    matchesIn(sourceFile, (node) =>
      openSchemaMessage(node).flatMap((message) => (isEncoded(node) ? [] : [{ node, message }])),
    ),
}

/** `Name<…>` with `Name` a plain identifier: its type arguments, or none. */
const typeArgumentsOf = (type: ts.TypeNode, name: string): ReadonlyArray<ts.TypeNode> =>
  ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === name
    ? (type.typeArguments ?? [])
    : []

const OPEN_VALUES: ReadonlyArray<ts.SyntaxKind> = [ts.SyntaxKind.UnknownKeyword, ts.SyntaxKind.AnyKeyword]

/** What a cast to `type` asserts, past parentheses and `Readonly<…>`: an
 *  open record or an object type literal. */
const assertedShape = (type: ts.TypeNode): ReadonlyArray<string> => {
  if (ts.isParenthesizedTypeNode(type)) return assertedShape(type.type)
  const readonly = typeArgumentsOf(type, "Readonly")
  if (readonly.length === 1) return readonly.flatMap(assertedShape)
  if (ts.isTypeLiteralNode(type)) return ["`as { … }` asserts an object shape that nothing checked"]
  const [key, value] = typeArgumentsOf(type, "Record")
  return key?.kind === ts.SyntaxKind.StringKeyword && value !== undefined && OPEN_VALUES.includes(value.kind)
    ? [`\`as Record<string, ${value.kind === ts.SyntaxKind.AnyKeyword ? "any" : "unknown"}>\` asserts an object that nothing checked`]
    : []
}

/** Casting a value to an object shape is a decode without the check: the
 *  fields are read as if they were there. A Schema decodes them and fails
 *  as a value when they are not. */
export const noRecordCast: IdiomRule = {
  id: RuleId.make("effect/no-record-cast"),
  defaultSeverity: "error",
  description: "an object read from outside is decoded, never cast to `Record<string, unknown>` or `{ … }`",
  fixHint:
    "decode it (`Schema.decodeUnknownOption(Schema.Struct({ … }))`, `Schema.JsonObject`), narrow with `Predicate.hasProperty`/`Predicate.isObject`, or fix the type at its source",
  check: ({ sourceFile }) =>
    matchesIn(sourceFile, (node) =>
      ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
        ? assertedShape(node.type).map((message) => ({ node, message }))
        : [],
    ),
}
