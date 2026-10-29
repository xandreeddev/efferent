import { describe, expect, test } from "bun:test"
import { SchemaAST } from "effect"
import { TransientTurnEvents, TurnEvent } from "./turn-event.entity.js"

/** The event reference (`docs/event-reference.md`) is generated from these descriptions: none may be missing. */
describe("the turn's event vocabulary", () => {
  const described = TurnEvent.members.map((member) => ({
    tag: member.fields._tag.schema.literal,
    description: SchemaAST.resolveDescription(member.ast) ?? "",
  }))

  test("every member has a description of at least 40 characters", () => {
    expect(described.filter((member) => member.description.trim().length < 40).map((member) => member.tag)).toEqual([])
  })

  test("the sixteen members, each with its own description", () => {
    expect(described.map((member) => member.tag)).toEqual([
      "turn.started", "step.started", "tool.started", "tool.refused", "tool.progress", "tool.completed", "step.ended", "completion.evaluated",
      "skills.activated", "context.built", "decision.recorded", "assistant.message", "assistant.delta", "stream.fallback", "turn.ended", "host",
    ])
    expect(new Set(described.map((member) => member.description)).size).toBe(described.length)
  })

  test("a transient event says so", () => {
    expect(described.filter((member) => TransientTurnEvents.includes(member.tag)).every((member) => member.description.includes("Transient"))).toBe(true)
  })
})
