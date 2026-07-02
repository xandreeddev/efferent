import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "../entities/AgentEvent.js"
import {
  derivePhase,
  initialPhaseState,
  reducePhase,
  submittedPhaseState,
  type PhaseState,
} from "./agentPhase.js"

const fold = (events: ReadonlyArray<AgentEvent>, start: PhaseState = initialPhaseState): PhaseState =>
  events.reduce(reducePhase, start)

describe("agentPhase — daemon-authoritative phase derivation", () => {
  test("turn_start → thinking; root tool start → tool; last tool end → thinking", () => {
    const s1 = fold([
      { type: "turn_start", turnIndex: 0 },
      { type: "tool_call_start", turnIndex: 0, id: "a", toolName: "read_file", args: {} },
    ])
    expect(s1.phase).toBe("tool")
    expect(s1.openToolCount).toBe(1)

    const s2 = reducePhase(s1, {
      type: "tool_call_end",
      turnIndex: 0,
      id: "a",
      toolName: "read_file",
      ok: true,
      result: {},
    })
    expect(s2.phase).toBe("thinking")
    expect(s2.openToolCount).toBe(0)
  })

  test("parallel root tools stay in `tool` until the LAST end", () => {
    const s = fold([
      { type: "tool_call_start", turnIndex: 0, id: "a", toolName: "grep", args: {} },
      { type: "tool_call_start", turnIndex: 0, id: "b", toolName: "ls", args: {} },
    ])
    expect(s.phase).toBe("tool")
    expect(s.openToolCount).toBe(2)
    const afterOne = reducePhase(s, {
      type: "tool_call_end",
      turnIndex: 0,
      id: "a",
      toolName: "grep",
      ok: true,
      result: {},
    })
    expect(afterOne.phase).toBe("tool") // one still open
    const afterBoth = reducePhase(afterOne, {
      type: "tool_call_end",
      turnIndex: 0,
      id: "b",
      toolName: "ls",
      ok: true,
      result: {},
    })
    expect(afterBoth.phase).toBe("thinking")
  })

  test("run_agent and sub-agent inner tools never move the root phase", () => {
    const s = fold([
      { type: "turn_start", turnIndex: 0 },
      // run_agent's lifetime IS the fleet — it must not open a root tool.
      { type: "tool_call_start", turnIndex: 0, id: "r", toolName: "run_agent", args: {} },
      // an inner tool carries a nodeId → belongs to the fleet, not the root.
      { type: "tool_call_start", turnIndex: 0, id: "x", toolName: "ls", args: {}, nodeId: "n1" },
    ])
    expect(s.phase).toBe("thinking")
    expect(s.openToolCount).toBe(0)
  })

  test("a sequence of events folds to the expected phase (thinking mid-turn)", () => {
    // user submits, model thinks, calls a tool, tool still open → tool.
    const ps = derivePhase([
      { type: "user_message", turnIndex: 0, text: "go" },
      { type: "turn_start", turnIndex: 0 },
      { type: "assistant_message", turnIndex: 0, text: "" },
      { type: "tool_call_start", turnIndex: 0, id: "a", toolName: "edit_file", args: {} },
    ])
    expect(ps.phase).toBe("tool")
  })

  test("agent_end clears a stale thinking → idle (kills the phantom spinner)", () => {
    // Daemon has finished, but the client thinks we're mid-turn. Folding the
    // daemon's terminal event must yield idle.
    const afterEnd = reducePhase(submittedPhaseState, {
      type: "agent_end",
      finalText: "done",
    })
    expect(afterEnd).toEqual(initialPhaseState)

    // An error also settles to idle (an aborted turn must not leave thinking stuck).
    const afterErr = reducePhase(
      { phase: "tool", openToolCount: 3 },
      { type: "error", message: "boom" },
    )
    expect(afterErr).toEqual(initialPhaseState)
  })

  test("a new turn settles dangling root tools (interrupt-safety)", () => {
    const s = fold([
      { type: "tool_call_start", turnIndex: 0, id: "a", toolName: "grep", args: {} },
      { type: "turn_start", turnIndex: 1 },
    ])
    expect(s.phase).toBe("thinking")
    expect(s.openToolCount).toBe(0)
  })

  test("non-lifecycle events leave the phase unchanged", () => {
    const s0: PhaseState = { phase: "tool", openToolCount: 1 }
    for (const e of [
      { type: "skill_load", name: "x" } as const,
      { type: "board_note", from: "a", note: "n", at: 1 } as const,
      { type: "assistant_message", turnIndex: 0, text: "hi" } as const,
    ]) {
      expect(reducePhase(s0, e)).toEqual(s0)
    }
  })
})
