import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "../../events.js"
import {
  agentStateForPhase,
  agentStateLabel,
  fleetCompletionLine,
  fleetLabel,
  idleAgentState,
  loaderState,
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

  test("agent_end settles the ROOT to idle but keeps a still-running background fleet", () => {
    // Spawning is non-blocking: the root turn can end while its agent keeps
    // working in the background, so agent_end must NOT wipe the fleet — only the
    // agent's own subagent_end removes it.
    const afterEnd = run([
      { e: { type: "subagent_start", name: "a", task: "t", nodeId: "1" } },
      { e: { type: "agent_end", finalText: "done" } },
    ])
    expect(afterEnd.phase).toBe("idle")
    expect(afterEnd.fleet).toEqual([{ nodeId: "1", name: "a" }])
    expect(fleetLabel(afterEnd)).toBe("1 agent · a")

    // When that agent finishes, the fleet drains and the chip clears.
    const afterDrain = run([
      { e: { type: "subagent_start", name: "a", task: "t", nodeId: "1" } },
      { e: { type: "agent_end", finalText: "done" } },
      { e: { type: "subagent_end", name: "a", nodeId: "1", ok: true, summary: "s", filesChanged: [] } },
    ])
    expect(afterDrain.fleet).toEqual([])
    expect(fleetLabel(afterDrain)).toBeUndefined()
    expect(agentStateLabel(idleAgentState)).toBe("idle")
  })

  test("loaderState: thinking while the root runs, 'waiting for N agents' while the fleet runs on, hidden when idle", () => {
    // Root's own turn in flight → thinking + the elapsed clock.
    expect(loaderState(submittedAgentState(1000))).toEqual({ label: "thinking", showElapsed: true })

    // Root turn ended (idle) but background agents run on → the waiting status,
    // no elapsed (there's no single root clock for the fleet).
    const waiting: AgentState = {
      phase: "idle",
      since: 1000,
      openToolCount: 0,
      fleet: [{ nodeId: "n1", name: "a" }, { nodeId: "n2", name: "b" }],
    }
    expect(loaderState(waiting)).toEqual({ label: "waiting for 2 agents", showElapsed: false })
    expect(loaderState({ ...waiting, fleet: [{ nodeId: "n1", name: "a" }] })).toEqual({
      label: "waiting for 1 agent",
      showElapsed: false,
    })

    // Idle + empty fleet → nothing to show (the loader hides).
    expect(loaderState(idleAgentState)).toBeUndefined()
  })

  test("fleetCompletionLine: one tidy ✓/✗ line, summary reduced to its first non-empty line and clipped", () => {
    expect(fleetCompletionLine("backend", true, "added a timeout wrapper")).toBe(
      "✓ backend — added a timeout wrapper",
    )
    // Failure → ✗.
    expect(fleetCompletionLine("qa", false, "tests still red")).toBe("✗ qa — tests still red")
    // Multi-line summary → just the first non-empty line (no wall of prose).
    expect(fleetCompletionLine("research", true, "\n\nLibraries compared.\nMore detail…")).toBe(
      "✓ research — Libraries compared.",
    )
    // No summary → name only.
    expect(fleetCompletionLine("lead", true, "   ")).toBe("✓ lead")
    // Over-long first line is clipped with an ellipsis.
    const long = "x".repeat(200)
    const out = fleetCompletionLine("lead", true, long)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBeLessThan(120)
  })

  test("a new turn settles any dangling root tools (interrupt-safety)", () => {
    const s = run([
      { e: { type: "tool_call_start", turnIndex: 0, id: "a", toolName: "grep", args: {} }, label: "Grep(x)" },
      { e: { type: "turn_start", turnIndex: 1 } },
    ])
    expect(s.phase).toBe("thinking")
    expect(s.openToolCount).toBe(0)
  })

  test("agentStateForPhase reconciles to the daemon's authoritative phase", () => {
    // The phantom-spinner kill: a client stuck "thinking" must snap to idle when
    // the daemon reports idle — and the open tool count is cleared with it.
    const stuck: AgentState = { phase: "thinking", since: 1000, openToolCount: 2, fleet: [] }
    const reconciled = agentStateForPhase(stuck, "idle", 9000)
    expect(reconciled.phase).toBe("idle")
    expect(reconciled.since).toBe(9000)
    expect(reconciled.openToolCount).toBe(0)

    // A client that joins mid-turn (idle locally) adopts the daemon's thinking.
    const joined = agentStateForPhase(idleAgentState, "thinking", 9000)
    expect(joined.phase).toBe("thinking")

    // The live fleet (tracked separately, seeded from the context tree) survives.
    const withFleet: AgentState = {
      phase: "thinking",
      since: 1000,
      openToolCount: 0,
      fleet: [{ nodeId: "n1", name: "audit" }],
    }
    expect(agentStateForPhase(withFleet, "idle", 9000).fleet).toEqual([
      { nodeId: "n1", name: "audit" },
    ])

    // No phase change → identity (no spurious `since` churn restarting the timer).
    const same: AgentState = { phase: "tool", since: 1000, openToolCount: 1, fleet: [] }
    expect(agentStateForPhase(same, "tool", 9000)).toBe(same)
  })
})
