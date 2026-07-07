import { describe, expect, test } from "bun:test"
import { mathAgentSystemPrompt } from "./prompt.js"

/** The prompt IS the model-facing contract — these assertions keep its
 *  load-bearing clauses from silently regressing (the discipline the deleted
 *  mathKit doc test used, now against the prompt). */
describe("math tutor prompt", () => {
  const text = mathAgentSystemPrompt(new Date("2026-07-05"))

  test("teaches the structured tool with one complete exemplar", () => {
    expect(text).toContain("render_math")
    expect(text).toContain('"kind": "exercise"')
    expect(text).toContain('"answer": { "kind": "fraction", "value": "3/4" }')
    expect(text).toContain('"hint"')
    expect(text).toContain('"solution"')
    expect(text).toContain('"difficulty"')
  })

  test("stresses the answer-key contract — the server grades verbatim", () => {
    expect(text).toContain("THE KEY MUST BE CORRECT")
    expect(text).toContain("recompute every answer")
    expect(text).toContain("grades the student's answer against your \"value\" VERBATIM")
  })

  test("teaches the driver's message vocabulary", () => {
    ;[
      "[action] start",
      "[action] more",
      "[action] harder",
      "[action] topic",
      "[progress]",
      "reported",
    ].forEach((s) => {
      expect(text).toContain(s)
    })
  })

  test("no HTML/Tailwind/canvas residue — content is data now", () => {
    ;["render_ui", "Tailwind", "tailwind", "hx-post", "/action/ui", "bg-white", "<div"].forEach((absent) => {
      expect(text).not.toContain(absent)
    })
    expect(text).toContain("presentation-MathML")
  })

  test("math-only identity + batching discipline", () => {
    expect(text).toContain("not a general assistant")
    expect(text).toContain("3-5 exercises per call")
    expect(text).toContain("unique forever in this session")
  })
})
