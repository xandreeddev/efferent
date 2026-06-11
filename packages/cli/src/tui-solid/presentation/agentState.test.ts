import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "../../events.js"
import {
  agentStateLabel,
  fleetLabel,
  idleAgentState,
  reduceAgentState,
  submittedAgentState,
  type AgentState,
} from "./agentState.js"

const run = (
  events: ReadonlyArray<{ e: AgentEvent; label?: string }>,
  start: AgentState = submittedAgentState(1000),
): AgentState =>
  events.reduce((s, { e, label }, i) => reduceAgentState(s, e, 1000 + (i + 1) * 100, label), start)

describe("agentState — the live state machine", () => {
  test("submit → thinking; tool start → tool with the label; last end → thinking", () => {
    const s0 = submittedAgentState(1000)
    expect(s0.phase).toBe("thinking")
    expect(agentStateLabel(s0)).toBe("thinking")

    const s1 = run([
      { e: { type: "turn_start", turnIndex: 0 } },
      {
        e: { type: "tool_call_start", turnIndex: 0, id: "a", toolName: "read_file", args: {} },
        label: "Read(main.ts)",
      },
    ])
    expect(s1.phase).toBe("tool")
    expect(agentStateLabel(s1)).toBe("Read(main.ts)")

    const s2 = reduceAgentState(
      s1,
      { type: "tool_call_end", turnIndex: 0, id: "a", toolName: "read_file", ok: true, result: {} },
      2000,
    )
    expect(s2.phase).toBe("thinking")
  })

  test("parallel root tools read `N tools`; ends count down", () => {
    const s = run([
      { e: { type: "tool_call_start", turnIndex: 0, id: "a", toolName: "grep", args: {} }, label: "Grep(x)" },
      { e: { type: "tool_call_start", turnIndex: 0, id: "b", toolName: "ls", args: {} }, label: "Ls(.)" },
    ])
    expect(agentStateLabel(s)).toBe("2 tools")
    const after = reduceAgentState(
      s,
      { type: "tool_call_end", turnIndex: 0, id: "a", toolName: "grep", ok: true, result: {} },
      3000,
    )
    expect(after.phase).toBe("tool")
    expect(agentStateLabel(after)).toBe("Ls(.)")
  })

  test("the fleet tracks sub-agents; run_agent and inner tools never touch the phase", () => {
    const s = run([
      { e: { type: "tool_call_start", turnIndex: 0, id: "r1", toolName: "run_agent", args: {} } },
      { e: { type: "subagent_start", name: "audit state", task: "t", nodeId: "n1" } },
      { e: { type: "subagent_start", name: "fix scroll", task: "t", nodeId: "n2" } },
      { e: { type: "tool_call_start", turnIndex: 0, id: "x", toolName: "ls", args: {}, nodeId: "n1" } },
    ])
    expect(s.phase).toBe("thinking") // run_agent + inner tools don't open root tools
    expect(s.fleet.map((m) => m.name)).toEqual(["audit state", "fix scroll"])
    expect(fleetLabel(s)).toBe("2 agents · audit state, fix scroll")

    const one = reduceAgentState(
      s,
      { type: "subagent_end", name: "audit state", nodeId: "n1", ok: true, summary: "", filesChanged: [] },
      5000,
    )
    expect(fleetLabel(one)).toBe("1 agent · fix scroll")
  })

  test("fleetLabel clips beyond maxNames with a +N suffix", () => {
    const s = run([
      { e: { type: "subagent_start", name: "a", task: "t", nodeId: "1" } },
      { e: { type: "subagent_start", name: "b", task: "t", nodeId: "2" } },
      { e: { type: "subagent_start", name: "c", task: "t", nodeId: "3" } },
    ])
    expect(fleetLabel(s)).toBe("3 agents · a, b +1")
  })

  test("agent_end and error settle to idle; idle has no fleet residue", () => {
    const s = run([
      { e: { type: "subagent_start", name: "a", task: "t", nodeId: "1" } },
      { e: { type: "agent_end", finalText: "done", messages: [] } },
    ])
    expect(s.phase).toBe("idle")
    expect(s.fleet).toEqual([])
    expect(fleetLabel(s)).toBeUndefined()
    expect(agentStateLabel(idleAgentState)).toBe("idle")
  })

  test("a new turn settles any dangling root tools (interrupt-safety)", () => {
    const s = run([
      { e: { type: "tool_call_start", turnIndex: 0, id: "a", toolName: "grep", args: {} }, label: "Grep(x)" },
      { e: { type: "turn_start", turnIndex: 1 } },
    ])
    expect(s.phase).toBe("thinking")
    expect(s.openToolCount).toBe(0)
  })
})
