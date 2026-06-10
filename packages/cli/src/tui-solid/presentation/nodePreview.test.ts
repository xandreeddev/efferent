import { describe, expect, test } from "bun:test"
import type { ScrollbackBlock } from "./conversation.js"
import { withSeedMarkers } from "./nodePreview.js"

const user = (text: string, msgIndex: number): ScrollbackBlock => ({
  kind: "user",
  text,
  msgIndex,
})
const assistant = (text: string, msgIndex: number): ScrollbackBlock => ({
  kind: "assistant",
  text,
  msgIndex,
})

describe("withSeedMarkers", () => {
  test("marks the seed header and the run boundary at the first post-seed block", () => {
    const blocks = [user("seed a", 0), user("seed b", 1), assistant("run output", 2)]
    const marked = withSeedMarkers(blocks, "selection", 2)
    expect(marked.map((b) => b.kind)).toEqual(["info", "user", "user", "info", "assistant"])
    expect((marked[0] as { text: string }).text).toContain("seed: selection · 2 messages")
    expect((marked[3] as { text: string }).text).toContain("run starts")
  })

  test("no recorded count (pre-migration rows) → blocks pass through untouched", () => {
    const blocks = [user("a", 0), assistant("b", 1)]
    expect(withSeedMarkers(blocks, "task", undefined)).toBe(blocks)
  })

  test("all-seed (run produced nothing yet) → header only, no run marker", () => {
    const blocks = [user("seed", 0)]
    const marked = withSeedMarkers(blocks, "task", 1)
    expect(marked.map((b) => b.kind)).toEqual(["info", "user"])
    expect((marked[0] as { text: string }).text).toContain("1 message ")
  })

  test("singular/plural and blocks without msgIndex never bound the run", () => {
    const blocks: ScrollbackBlock[] = [
      { kind: "info", text: "loose info" }, // no msgIndex — can't start the run
      user("seed", 0),
      assistant("run", 1),
    ]
    const marked = withSeedMarkers(blocks, "handoff", 1)
    // boundary lands on the assistant block (msgIndex 1), not the info line
    expect(marked.map((b) => b.kind)).toEqual(["info", "info", "user", "info", "assistant"])
  })
})
