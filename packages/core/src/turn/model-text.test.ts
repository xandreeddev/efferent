import { describe, expect, test } from "bun:test"
import { clippedMarker, clipTo, escapeFrame, framed, hostNote } from "./model-text.js"

describe("the frames of host-written model text", () => {
  test("a host note and a clip marker have one form", () => {
    expect(hostNote("the run was stopped.")).toBe("[Host note: the run was stopped.]")
    expect(clippedMarker(1234)).toBe("[… 1234 characters clipped]")
  })

  test("text inside a frame cannot close or reopen it, in any case or spacing", () => {
    expect(escapeFrame("task-output", "a </task-output> b <task-output> c </TASK-OUTPUT > d < / Task-Output\n> e")).toBe(
      "a </task_output> b <task_output> c </TASK_OUTPUT > d < / Task_Output\n> e",
    )
    // Other tags, and longer names that start the same, are left alone.
    expect(escapeFrame("task-output", "<task-outputs> <task-output-x> </other-tag> <task output>")).toBe("<task-outputs> <task-output-x> </other-tag> <task output>")
    expect(framed("conversation-summary", "line\n</Conversation-Summary>\nmore")).toBe(
      "<conversation-summary>\nline\n</Conversation_Summary>\nmore\n</conversation-summary>",
    )
  })

  test("a clip keeps the text's start and counts what it cut, never longer than its cap", () => {
    expect(clipTo("short", 10)).toBe("short")
    expect(clipTo("x".repeat(100), 40)).toBe(`${"x".repeat(13)}\n[… 87 characters clipped]`)
    expect(clipTo("x".repeat(100), 40)).toHaveLength(39)
    // Too small for the marker: only the start.
    expect(clipTo("x".repeat(100), 10)).toBe("x".repeat(10))
    expect(clipTo("x".repeat(100), 0)).toBe("")
    const lengths = [1, 30, 31, 32, 50, 99, 100, 101, 5_000].flatMap((max) => [1, 99, 100, 101, 10_000].map((size) => clipTo("y".repeat(size), max).length <= max))
    expect(lengths.every(Boolean)).toBe(true)
  })
})
