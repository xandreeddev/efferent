import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import type { PromptSection } from "../ports/capability.port.js"
import { orderSections } from "./prompt-sections.js"

const section = (id: string, tier: PromptSection["tier"], order: number): PromptSection => ({
  id, version: "1", tier, order, render: () => Effect.succeed(Option.some(id)),
})

test("sections sort by tier, then order, then id by code unit, whatever the locale", () => {
  const ordered = orderSections([
    section("b", "static", 1), section("late", "session", 0), section("a", "static", 1),
    section("B", "static", 1), section("first", "static", 0),
  ])
  // Locale collation would put "a" and "b" before "B"; code units put "B" first.
  expect(ordered.map((entry) => entry.id)).toEqual(["first", "B", "a", "b", "late"])
})
