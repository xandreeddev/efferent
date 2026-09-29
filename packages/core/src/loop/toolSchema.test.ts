import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Tool } from "effect/ai"
import { strictJsonSchema, toolParametersSchema } from "./toolSchema.js"

describe("strictJsonSchema", () => {
  test("an optional key is absent, never null; an explicit null stays", () => {
    const schema = strictJsonSchema(
      Schema.Struct({
        query: Schema.optional(Schema.String),
        note: Schema.optional(Schema.NullOr(Schema.String)),
        limit: Schema.optionalKey(Schema.Int),
      })
    )
    expect(schema).toEqual({
      type: "object",
      properties: {
        query: { type: "string" },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        limit: { type: "integer" },
      },
      additionalProperties: false,
    })
  })

  test("numbers are finite and keep their bounds", () => {
    expect(
      strictJsonSchema(Schema.Struct({ score: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))) }))
    ).toEqual({
      type: "object",
      properties: { score: { type: "number", minimum: 0, maximum: 1 } },
      required: ["score"],
      additionalProperties: false,
    })
  })

  test("a transformed field is described by what the decoder reads", () => {
    expect(strictJsonSchema(Schema.Struct({ count: Schema.NumberFromString }))).toEqual({
      type: "object",
      properties: { count: { type: "string" } },
      required: ["count"],
      additionalProperties: false,
    })
  })

  test("what the schema promises, the tool decoder accepts", () => {
    const tool = Tool.make("search", {
      parameters: Schema.Struct({ query: Schema.optional(Schema.String), page: Schema.optional(Schema.Number) }),
    })
    const parameters = toolParametersSchema(tool)
    expect(JSON.stringify(parameters)).not.toContain("null")
    expect(JSON.stringify(parameters)).not.toContain("Infinity")
    expect(Schema.decodeUnknownSync(tool.parametersSchema)({})).toEqual({})
    expect(Schema.decodeUnknownSync(tool.parametersSchema)({ query: "a", page: 2 })).toEqual({ query: "a", page: 2 })
  })
})
