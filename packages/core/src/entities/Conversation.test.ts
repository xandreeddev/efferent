import { describe, expect, it } from "bun:test"
import { Arbitrary, FastCheck as fc, Schema } from "effect"
import { AgentMessage, Checkpoint } from "./Conversation.js"

const roundTrip = <A, I>(schema: Schema.Schema<A, I>) => {
  const encode = Schema.encodeSync(schema)
  const decode = Schema.decodeUnknownSync(schema)
  return (value: A) => expect(decode(encode(value))).toEqual(value)
}

describe("properties — encode/decode round-trip", () => {
  it("AgentMessage survives encode→decode for any generated message", () => {
    // Exercises all three union members, all four part types, and the
    // Schema.Unknown payloads (tool input/output, providerOptions).
    fc.assert(fc.property(Arbitrary.make(AgentMessage), roundTrip(AgentMessage)), {
      numRuns: 100,
    })
  })

  it("Checkpoint survives encode→decode (branded ConversationId)", () => {
    fc.assert(fc.property(Arbitrary.make(Checkpoint), roundTrip(Checkpoint)), {
      numRuns: 100,
    })
  })
})
