import type { AgentEvent } from "../../events.js"

/**
 * The agent's live state machine — *what is the agent doing right now*, as one
 * pure value derived from the same `AgentEvent` stream everything else reads.
 * The header chrome renders it permanently; the rail's thinking indicator and
 * the status surfaces all read this instead of inferring state from `busy`.
 *
 *   idle ──submit──▶ thinking ──tool start──▶ tool ──last tool end──▶ thinking
 *     ▲                                                                  │
 *     └────────────────────── agent_end / error ◀──────────────────────-┘
 *
 * The **fleet** (live sub-agents) is orthogonal to the phase: the root can be
 * mid-`run_agent` (phase `tool`) while three agents work — the header shows
 * both. Root tool counting skips `run_agent` itself (its lifetime IS the
 * fleet membership; counting it twice would pin `detail` on the spawn call
 * for minutes).
 */
export type AgentPhase = "idle" | "thinking" | "tool"

export interface FleetMember {
  readonly nodeId: string
  readonly name: string
  /** The model tier this agent runs as (`general` | `code`) — so the status bar
   *  can show the active tier when this agent is the focused one. */
  readonly role?: "general" | "code"
}

export interface AgentState {
  readonly phase: AgentPhase
  /** ms timestamp when the phase last changed; 0 = never ran. */
  readonly since: number
  /** Open ROOT tool calls (sub-agent inner tools belong to the fleet). */
  readonly openToolCount: number
  /** The most recently started root tool's label (e.g. `Read(main.ts)`). */
  readonly lastTool?: string
  /** Live sub-agents, in spawn order. */
  readonly fleet: ReadonlyArray<FleetMember>
}

export const idleAgentState: AgentState = {
  phase: "idle",
  since: 0,
  openToolCount: 0,
  fleet: [],
}

/** The user just sent a message — thinking until the loop says otherwise. */
export const submittedAgentState = (now: number): AgentState => ({
  phase: "thinking",
  since: now,
  openToolCount: 0,
  fleet: [],
})

const phaseTo = (s: AgentState, phase: AgentPhase, now: number): AgentState =>
  s.phase === phase ? s : { ...s, phase, since: now }

/**
 * Fold one agent event into the state. `toolLabel` is the already-described
 * call label (the pump has it from `describeToolCall`); ends don't need one.
 */
export const reduceAgentState = (
  s: AgentState,
  e: AgentEvent,
  now: number,
  toolLabel?: string,
): AgentState => {
  switch (e.type) {
    case "turn_start":
      // A new model call: tools from the previous turn are settled.
      return { ...phaseTo(s, "thinking", now), openToolCount: 0 }
    case "tool_call_start": {
      if (e.nodeId !== undefined) return s // a fleet member's inner tool
      if (e.toolName === "run_agent") return s // its lifetime IS the fleet
      const next = {
        ...s,
        openToolCount: s.openToolCount + 1,
        ...(toolLabel !== undefined ? { lastTool: toolLabel } : { lastTool: e.toolName }),
      }
      return phaseTo(next, "tool", now)
    }
    case "tool_call_end": {
      if (e.nodeId !== undefined || e.toolName === "run_agent") return s
      const open = Math.max(0, s.openToolCount - 1)
      const next = { ...s, openToolCount: open }
      // Last root tool settled → the model reads results: thinking again.
      return open === 0 ? phaseTo(next, "thinking", now) : next
    }
    case "subagent_start": {
      const member: FleetMember = {
        nodeId: e.nodeId ?? e.name,
        name: e.name,
        ...(e.role !== undefined ? { role: e.role } : {}),
      }
      return { ...s, fleet: [...s.fleet, member] }
    }
    case "subagent_end": {
      const key = e.nodeId ?? e.name
      const idx = s.fleet.findIndex((m) => m.nodeId === key)
      if (idx === -1) return s
      return { ...s, fleet: [...s.fleet.slice(0, idx), ...s.fleet.slice(idx + 1)] }
    }
    case "agent_end":
    case "error":
      // The ROOT turn ended — but its fleet runs on in the background (spawning
      // is non-blocking now), so keep the live members; each drains itself out
      // on its own subagent_end. Only the root's phase goes idle.
      return { ...idleAgentState, since: now, fleet: s.fleet }
    default:
      return s
  }
}

/** The header's phase text: `idle` · `thinking` · the running tool's label. */
export const agentStateLabel = (s: AgentState): string => {
  switch (s.phase) {
    case "idle":
      return "idle"
    case "thinking":
      return "thinking"
    case "tool":
      return s.openToolCount > 1 ? `${s.openToolCount} tools` : (s.lastTool ?? "working")
  }
}

/** Elapsed-time readout for the running spinner: `42s` under a minute, `1m9s`
 *  beyond. Shared by the header bar and the bottom-chrome running loader. */
export const formatElapsed = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${s - m * 60}s`
}

/** The fleet chip: `2 agents · haiku, audit` (names clipped to fit). */
export const fleetLabel = (s: AgentState, maxNames = 2): string | undefined => {
  if (s.fleet.length === 0) return undefined
  const names = s.fleet.slice(0, maxNames).map((m) => m.name)
  const more = s.fleet.length - names.length
  const suffix = more > 0 ? ` +${more}` : ""
  return `${s.fleet.length} agent${s.fleet.length === 1 ? "" : "s"} · ${names.join(", ")}${suffix}`
}
