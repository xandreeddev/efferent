import { describe, expect, test } from "bun:test"
import type { MathItem } from "../domain/MathContent.js"
import { applyTopic, emptyMathModel, setGenerating, type MathModel } from "./model.js"
import { reduceMathEvent } from "./reduce.js"

const ex = (id: string): MathItem => ({
  kind: "exercise",
  id,
  prompt: "2 + 2 = ?",
  answer: { kind: "integer", value: "4" },
  hint: "Count up twice.",
  solution: [{ text: "2 + 2 = 4" }],
})

/** A scoped launch's model: topic applied, generation flagged, nothing served. */
const waiting = (): MathModel =>
  setGenerating(applyTopic(emptyMathModel(), 4, "fractions"), true)

describe("math reducer", () => {
  test("math_render serves the batch and clears the pending state", () => {
    const r = reduceMathEvent(waiting(), { type: "math_render", items: [ex("ex-1"), ex("ex-2")] })
    expect(r.model.currentId).toBe("ex-1")
    expect(r.model.acceptedThisTurn).toBe(2)
    expect(r.patches.length).toBeGreaterThan(0)
  })

  test("a run that ends with ZERO exercises while the student waits is a loud error", () => {
    const m = waiting()
    const started = reduceMathEvent(m, { type: "turn_start", turnIndex: 0 }).model
    const r = reduceMathEvent(started, {
      type: "agent_end",
      finalText: "I could not decide what to write.",
    })
    expect(r.model.lastError?.message).toContain("without writing any exercises")
    expect(r.model.lastError?.detail).toContain("could not decide")
    expect(r.model.generating).toBe(false)
    expect(r.patches).toContain("stage")
  })

  test("a run that DID render ends quietly (no error, generating cleared)", () => {
    const m0 = reduceMathEvent(waiting(), { type: "turn_start", turnIndex: 0 }).model
    const m = reduceMathEvent(m0, { type: "math_render", items: [ex("ex-1")] }).model
    const r = reduceMathEvent(m, { type: "agent_end", finalText: "done" })
    expect(r.model.lastError).toBeUndefined()
    expect(r.model.generating).toBe(false)
  })

  test("an error event with an exercise on screen degrades quietly; without one it surfaces", () => {
    const onScreen = reduceMathEvent(waiting(), { type: "math_render", items: [ex("ex-1")] }).model
    const quiet = reduceMathEvent(setGenerating(onScreen, true), { type: "error", message: "429" })
    expect(quiet.model.lastError).toBeUndefined()
    const loud = reduceMathEvent(waiting(), { type: "error", message: "429" })
    expect(loud.model.lastError?.detail).toBe("429")
  })

  test("chat-ish events are no-ops on this surface", () => {
    const m = waiting()
    ;[
      { type: "assistant_message", turnIndex: 0, text: "hello" } as const,
      { type: "user_message", turnIndex: 0, text: "hi" } as const,
      { type: "skill_load", name: "x" } as const,
    ].forEach((event) => {
      const r = reduceMathEvent(m, event)
      expect(r.model).toBe(m)
      expect(r.patches).toEqual([])
    })
  })
})
