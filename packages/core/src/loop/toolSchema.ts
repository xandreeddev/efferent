import { Match, Record, Schema, SchemaRepresentation } from "effect"
import type { JsonSchema } from "effect"
import type { Tool } from "effect/ai"

type Representation = SchemaRepresentation.Representation

/** `Schema.Finite`'s checks: what makes Effect render a plain `number`. */
const finiteChecks = ((finite: Representation) => (finite._tag === "Number" ? finite.checks : []))(
  SchemaRepresentation.toRepresentation(Schema.Finite.ast).representation
)
const finiteIds = new Set(finiteChecks.flatMap((check) => (check.representation === undefined ? [] : [check.representation.id])))

const isFinite = (checks: ReadonlyArray<SchemaRepresentation.Check>) =>
  checks.some((check) => check.representation !== undefined && finiteIds.has(check.representation.id))

/** An optional key or element without `undefined`: in JSON it is absent instead. */
const absentWhenOptional = (isOptional: boolean, type: Representation): Representation => {
  if (!isOptional || type._tag !== "Union") return type
  const types = type.types.filter((member) => member._tag !== "Undefined")
  const [only] = types
  return types.length === 1 && only !== undefined && type.checks.length === 0 && type.annotations === undefined
    ? only
    : { ...type, types }
}

/** A representation narrowed to what a model can write in JSON and the plain decoder accepts. */
const modelFacing = (representation: Representation): Representation =>
  Match.value(representation).pipe(
    Match.tag("Number", (number): Representation =>
      isFinite(number.checks) ? number : { ...number, checks: [...finiteChecks, ...number.checks] }
    ),
    Match.tag("Objects", (objects): Representation => ({
      ...objects,
      propertySignatures: objects.propertySignatures.map((property) => ({
        ...property,
        type: absentWhenOptional(property.isOptional, modelFacing(property.type)),
      })),
      indexSignatures: objects.indexSignatures.map((signature) => ({ ...signature, type: modelFacing(signature.type) })),
    })),
    Match.tag("Arrays", (arrays): Representation => ({
      ...arrays,
      elements: arrays.elements.map((element) => ({
        ...element,
        type: absentWhenOptional(element.isOptional, modelFacing(element.type)),
      })),
      rest: arrays.rest.map(modelFacing),
    })),
    Match.tag("Union", (union): Representation => ({ ...union, types: union.types.map(modelFacing) })),
    Match.tag("Suspend", (suspend): Representation => ({ ...suspend, thunk: modelFacing(suspend.thunk) })),
    Match.orElse((other): Representation => other)
  )

/**
 * The JSON Schema a model sees for a schema: what it can write in JSON and the
 * schema's decoder (the one a toolkit runs on tool calls) accepts.
 *
 * - Objects are closed: Effect's generator leaves them open by default.
 * - An optional key may be absent, never `null`. Effect renders a schema
 *   through its JSON codec, where `undefined` is `null`, which the plain
 *   decoder rejects.
 * - Numbers are finite, since JSON has no `NaN` or `Infinity`.
 * - Definitions are inlined under `$defs`.
 */
export const strictJsonSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = SchemaRepresentation.toRepresentation(schema.ast)
  const compiled = SchemaRepresentation.toJsonSchemaDocument(
    { representation: modelFacing(document.representation), references: Record.map(document.references, modelFacing) },
    { onExcessProperty: "error" }
  )
  return Object.keys(compiled.definitions).length > 0
    ? { ...compiled.schema, $defs: compiled.definitions }
    : compiled.schema
}

/** A tool's parameters as the model sees them. */
export const toolParametersSchema = (tool: Tool.Any): JsonSchema.JsonSchema =>
  strictJsonSchema(tool.parametersSchema)
