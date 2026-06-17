import { describe, expect, it } from "bun:test"
import { Arbitrary, FastCheck as fc, Schema } from "effect"
import { AgentContextNode, ContextSeed } from "./AgentContext.js"

const roundTrip = <A, I>(schema: Schema.Schema<A, I>) => {
  const encode = Schema.encodeSync(schema)
  const decode = Schema.decodeUnknownSync(schema)
  return (value: A) => expect(decode(encode(value))).toEqual(value)
}

describe("properties — encode/decode round-trip", () => {
  it("AgentContextNode survives encode→decode (brands, NullOr, optionals, nested seed/usage)", () => {
    fc.assert(fc.property(Arbitrary.make(AgentContextNode), roundTrip(AgentContextNode)), {
      numRuns: 100,
    })
  })

  it("ContextSeed survives encode→decode for all three union members", () => {
    fc.assert(fc.property(Arbitrary.make(ContextSeed), roundTrip(ContextSeed)), {
      numRuns: 100,
    })
  })
})
