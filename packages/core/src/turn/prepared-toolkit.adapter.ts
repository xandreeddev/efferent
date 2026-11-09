import { Effect, Option, Schema } from "effect"
import { AiError, Toolkit } from "effect/ai"
import type { Tool } from "effect/ai"

import type { PreparedToolkit, PreparedToolHandler, PreparedToolExecution } from "../ports/prepared-toolkit.port.js"

const json = Schema.fromJsonString(Schema.Json)
const copy = (input: unknown) => Schema.decodeUnknownEffect(Schema.Json)(input).pipe(
  Effect.flatMap(Schema.encodeEffect(json)), Effect.flatMap(Schema.decodeUnknownEffect(json)),
)
const immutable = (input: Schema.Json): Schema.Json => {
  if (typeof input === "object" && input !== null) {
    Object.values(input).forEach(immutable)
    Object.freeze(input)
  }
  return input
}

/**
 * Keep authored schemas on the model-facing toolkit; execute prepared values
 * through tools with identity parameter codecs and the same handler keys.
 * The authored decoder gets a separate copy, never the provider's object or
 * the immutable raw evidence. Neither tools nor schemas are mutated.
 * @public
 */
export const prepareToolkit = <Tools extends Record<string, Tool.Any>>(
  base: Toolkit.Toolkit<Tools>,
  execute?: PreparedToolExecution,
): PreparedToolkit<Tools> => {
  const identity = Toolkit.make(...Object.values(base.tools).map((tool) => Object.create(tool, {
    parametersSchema: { value: Schema.Unknown },
  }) as Tool.Any))
  const execution = Effect.gen(function* () {
    const ready = yield* identity
    const handler: PreparedToolHandler = {
      prepare: Effect.fnUntraced(function* (name, input) {
        const tool = Object.hasOwn(base.tools, name) ? Option.fromNullishOr(base.tools[name]) : Option.none()
        if (Option.isNone(tool)) return yield* Effect.fail(AiError.make({ module: "Toolkit", method: "prepare", reason: new AiError.ToolNotFoundError({ toolName: name, availableTools: Object.keys(base.tools) }) }))
        const invalid = (error: Schema.SchemaError) => AiError.make({ module: "Toolkit", method: "prepare", reason: new AiError.ToolParameterValidationError({ toolName: name, description: error.message }) })
        const raw = immutable(yield* copy(input).pipe(Effect.mapError(invalid)))
        const decoderInput = yield* copy(raw).pipe(Effect.mapError(invalid))
        const schema = tool.value.parametersSchema
        const decoded = Schema.isSchema(schema) ? yield* Schema.decodeUnknownEffect(schema as Schema.Decoder<unknown>)(decoderInput).pipe(Effect.mapError(invalid)) : decoderInput
        return {
          input: raw,
          run: (id) => execute === undefined ? ready.handle(name, decoded, id) as ReturnType<import("../ports/prepared-toolkit.port.js").PreparedToolCall["run"]> : execute(identity, { name, input: raw, decoded, ...(id === undefined ? {} : { id }) }),
        }
      }),
    }
    return handler
  })
  return Object.assign(Object.create(base), { execution })
}
