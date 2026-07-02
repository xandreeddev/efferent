import { describe, expect, it } from "bun:test"
import { isEmptyResponseContent } from "./router.js"

// The forensic class this guards: the opencode gateway under load answers
// HTTP 200 with an empty body and `finishReason: "unknown"` — the loop read
// that as a completed turn ("turn 24: unknown · 0 tok"), so agents "finished"
// mid-thought and recorded a mid-sentence line as their deliverable.
describe("isEmptyResponseContent", () => {
  it("flags a response with no parts at all", () => {
    expect(isEmptyResponseContent([])).toBe(true)
  })

  it("flags a response whose only parts carry nothing (finish/usage, blank text)", () => {
    expect(isEmptyResponseContent([{ type: "finish" }])).toBe(true)
    expect(isEmptyResponseContent([{ type: "text", text: "" }, { type: "finish" }])).toBe(true)
    expect(isEmptyResponseContent([{ type: "text", text: "   " }])).toBe(true)
  })

  it("accepts real text", () => {
    expect(isEmptyResponseContent([{ type: "text", text: "done." }])).toBe(false)
  })

  it("accepts a tool call (even with no text)", () => {
    expect(isEmptyResponseContent([{ type: "tool-call" }, { type: "finish" }])).toBe(false)
  })

  it("accepts reasoning-only responses", () => {
    expect(isEmptyResponseContent([{ type: "reasoning", text: "thinking…" }])).toBe(false)
  })
})
