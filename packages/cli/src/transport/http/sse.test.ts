import { describe, expect, test } from "bun:test"
import type { AgentEvent, SeqEvent } from "@xandreed/sdk-core"
import {
  SSE_EVENT_AGENT,
  SSE_EVENT_RESYNC,
  encodeHeartbeat,
  encodeResync,
  encodeSeqEvent,
  frameToSeqEvent,
  makeSseParser,
} from "./sse.js"

const seqEvent = (seq: number, event: AgentEvent): SeqEvent => ({ seq, event })

describe("SSE codec", () => {
  test("encodeSeqEvent emits id/event/data terminated by a blank line", () => {
    const frame = encodeSeqEvent(seqEvent(5, { type: "turn_start", turnIndex: 2 }))
    expect(frame).toBe(
      `id: 5\nevent: ${SSE_EVENT_AGENT}\ndata: {"type":"turn_start","turnIndex":2}\n\n`,
    )
  })

  test("multi-line text serialises to a single data: line (JSON-escaped)", () => {
    const frame = encodeSeqEvent(
      seqEvent(1, { type: "assistant_message", turnIndex: 0, text: "line one\nline two" }),
    )
    // Exactly one data: line, no raw newline inside the payload.
    expect(frame.split("\n").filter((l) => l.startsWith("data:"))).toHaveLength(1)
    expect(frame).toContain("line one\\nline two")
  })

  test("round-trip: encode → parse → decode yields the original SeqEvent", () => {
    const original = seqEvent(7, {
      type: "tool_call_end",
      turnIndex: 1,
      id: "abc",
      toolName: "read_file",
      ok: true,
      result: { content: "x" },
    })
    const parser = makeSseParser()
    const frames = parser.push(encodeSeqEvent(original))
    expect(frames).toHaveLength(1)
    expect(frameToSeqEvent(frames[0]!)).toEqual(original)
  })

  test("parser reassembles a frame split across chunk boundaries", () => {
    const wire = encodeSeqEvent(seqEvent(3, { type: "turn_start", turnIndex: 0 }))
    const parser = makeSseParser()
    const mid = Math.floor(wire.length / 2)
    expect(parser.push(wire.slice(0, mid))).toHaveLength(0) // incomplete
    const frames = parser.push(wire.slice(mid))
    expect(frames).toHaveLength(1)
    expect(frameToSeqEvent(frames[0]!)?.seq).toBe(3)
  })

  test("parser yields multiple frames from one chunk, in order", () => {
    const a = encodeSeqEvent(seqEvent(1, { type: "turn_start", turnIndex: 0 }))
    const b = encodeSeqEvent(seqEvent(2, { type: "agent_end", finalText: "done" }))
    const frames = makeSseParser().push(a + b)
    expect(frames.map((f) => f.id)).toEqual(["1", "2"])
    expect(frameToSeqEvent(frames[1]!)?.event.type).toBe("agent_end")
  })

  test("heartbeat comments are skipped", () => {
    const parser = makeSseParser()
    const frames = parser.push(
      encodeHeartbeat() + encodeSeqEvent(seqEvent(9, { type: "turn_start", turnIndex: 0 })),
    )
    expect(frames).toHaveLength(1)
    expect(frames[0]!.id).toBe("9")
  })

  test("frameToSeqEvent returns undefined for a resync control frame", () => {
    const frames = makeSseParser().push(encodeResync())
    expect(frames).toHaveLength(1)
    expect(frames[0]!.event).toBe(SSE_EVENT_RESYNC)
    expect(frameToSeqEvent(frames[0]!)).toBeUndefined()
  })

  test("frameToSeqEvent rejects malformed payloads", () => {
    expect(frameToSeqEvent({ id: "1", event: SSE_EVENT_AGENT, data: "not json" })).toBeUndefined()
    expect(
      frameToSeqEvent({ id: "1", event: SSE_EVENT_AGENT, data: '{"type":"nope"}' }),
    ).toBeUndefined()
    expect(
      frameToSeqEvent({ event: SSE_EVENT_AGENT, data: '{"type":"turn_start","turnIndex":0}' }),
    ).toBeUndefined() // no id → no seq
  })
})
