import { describe, expect, it } from "bun:test"
import { eventParts } from "./openCode.js"

/**
 * The opencode SSE decoder turns OpenAI-shaped streaming deltas into Response
 * stream parts. The regression these lock: a `tool_calls: null` delta (which
 * glm-via-opencode sends on text-only chunks) must NOT crash the decode — the
 * old guard checked `!== undefined`, let `null` through, and `for…of null`
 * threw "null is not an object", killing every turn before any tool ran.
 */
describe("opencode SSE decode — null tool_calls", () => {
  it("decodes a text-only chunk whose tool_calls is null without throwing", () => {
    const decode = eventParts()
    const parts = decode({
      choices: [{ delta: { content: "hello", tool_calls: null } }],
    } as never)
    expect(parts).toEqual([{ type: "text-delta", id: "0", delta: "hello" }])
  })

  it("decodes a chunk with null tool_calls and no content as empty (no crash)", () => {
    const decode = eventParts()
    expect(decode({ choices: [{ delta: { tool_calls: null } }] } as never)).toEqual([])
  })

  it("still decodes real tool_calls deltas", () => {
    const decode = eventParts()
    const parts = decode({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "grep", arguments: "" } }],
          },
        },
      ],
    } as never)
    expect(parts).toContainEqual({ type: "tool-params-start", id: "call_1", name: "grep" })
  })
})
