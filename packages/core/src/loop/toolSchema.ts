import { Schema } from "effect"
import type { JsonSchema } from "effect"
import type { Tool } from "effect/ai"

/**
 * The JSON Schema a model sees for a schema: closed objects (no properties
 * the schema does not model), definitions inlined under `$defs`. Effect's
 * generator leaves objects open by default; tools are strict contracts.
 */
export const strictJsonSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  return Object.keys(document.definitions).length > 0
    ? { ...document.schema, $defs: document.definitions }
    : document.schema
}

/** A tool's parameters as the model sees them. */
export const toolParametersSchema = (tool: Tool.Any): JsonSchema.JsonSchema =>
  strictJsonSchema(tool.parametersSchema)
