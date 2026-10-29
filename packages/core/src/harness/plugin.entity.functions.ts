import { Option, Schema, SchemaAST } from "effect"
import { HarnessError } from "./plugin.entity.js"

const harnessErrorShape = Schema.is(Schema.Struct(HarnessError.fields))

/**
 * Whether a value is a `HarnessError`, by its tag and fields, whichever copy
 * of `@xandreed/core` made it. Two installed copies (a host and a plugin on
 * different versions) each have their own class, so `instanceof
 * HarnessError` is false for the other copy's errors and their codes would
 * be lost; check errors with this instead.
 */
export const isHarnessError = (value: unknown): value is HarnessError => harnessErrorShape(value)

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))

/** Whether a value is of the encoded shape `ast` describes, extra keys refused as a plugin's options refuse them. */
const fits = (ast: SchemaAST.AST, value: unknown): boolean =>
  Option.isSome(Schema.decodeUnknownOption(Schema.make<Schema.Codec<unknown>>(ast))(value, { onExcessProperty: "error" }))

const anything = Schema.Unknown.ast

/** The shape a key of an object of shape `ast` has: its field's, else its record's values', else anything. */
const fieldOf = (ast: SchemaAST.AST, key: string): SchemaAST.AST =>
  SchemaAST.isSuspend(ast) ? fieldOf(ast.thunk(), key)
    : SchemaAST.isObjects(ast) ? (ast.propertySignatures.find((field) => field.name === key) ?? ast.indexSignatures[0])?.type ?? anything
    : anything

const mergeFields = (ast: SchemaAST.AST, base: Readonly<Record<string, unknown>>, patch: object): Readonly<Record<string, unknown>> =>
  ({ ...base, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, mergeAt(fieldOf(ast, key), base[key], value)])) })

const mergeAt = (ast: SchemaAST.AST, base: unknown, patch: unknown): unknown => {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch
  if (!SchemaAST.isUnion(ast)) return mergeFields(ast, base, patch)
  const fitting = ast.types.map((member) => [member, mergeAt(member, base, patch)] as const).find(([member, merged]) => fits(member, merged))
  return fitting?.[1] ?? (fits(ast, patch) ? patch : mergeFields(anything, base, patch))
}

/**
 * A plugin's options over its defaults, as its schema decodes them. Plain
 * objects merge key by key at every depth (`{ inbox: { maxPending: 50 } }`
 * keeps the inbox's other defaults); anything else given, an array or a
 * string among them, replaces its default. Where the schema allows several
 * shapes, an object merges into its default only while the result is still
 * one of them: one of another shape (`{ ownership: { mode: "process" } }`
 * over a lease) replaces it.
 */
export const mergeOptions = (schema: Schema.Top, defaults: Readonly<Record<string, unknown>>, options: object): Readonly<Record<string, unknown>> =>
  mergeFields(SchemaAST.toEncoded(schema.ast), defaults, options)
