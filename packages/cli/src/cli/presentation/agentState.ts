import type { AgentEvent } from "../../events.js"
import type { AgentPhase } from "@xandreed/sdk-core"

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
 *
 * The `AgentPhase` literal + its transition rules are SHARED with the daemon
 * (`@xandreed/sdk-core` `agentPhase.ts` `reducePhase`): the daemon folds events
 * into `SessionState.phase`, and this machine reconciles against that on
 * (re)attach. Re-exported here so existing CLI imports of `AgentPhase` keep
 * working off one definition.
 */
export type { AgentPhase }

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

/**
 * Reconcile the local machine to the daemon's **authoritative** phase (read from
 * `SessionState.phase` on attach/resync). The fleet is tracked separately (it's
 * seeded from the context tree by `refreshNav`), so it's preserved; we only
 * adopt the daemon's phase and reset the root tool count, since the daemon's
 * phase already accounts for open tools. This is what kills a phantom
 * "thinking" — an idle daemon snaps the client back to idle even if a stale
 * stream left it stuck thinking.
 */
export const agentStateForPhase = (
  prev: AgentState,
  phase: AgentPhase,
  now: number,
): AgentState =>
  prev.phase === phase
    ? prev
    : { ...prev, phase, since: now, openToolCount: phase === "idle" ? 0 : prev.openToolCount }

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

/**
 * The running-loader line (bottom chrome, above the input). While the root's OWN
 * turn is in flight it's `thinking` (with the elapsed clock). When the root turn
 * has ended but background agents are still running, it becomes
 * `waiting for N agents` — so "it just works, we keep waiting" is visible instead
 * of a dead idle screen. Returns undefined when there's nothing to show (idle +
 * empty fleet). Pure — the view binds the spinner/colour around it.
 */
export const loaderState = (
  s: AgentState,
): { readonly label: string; readonly showElapsed: boolean } | undefined => {
  if (s.phase !== "idle") return { label: "thinking", showElapsed: true }
  const n = s.fleet.length
  if (n > 0) return { label: `waiting for ${n} agent${n === 1 ? "" : "s"}`, showElapsed: false }
  return undefined
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

/**
 * A single clean completion line for a TOP-LEVEL agent the root orchestrated —
 * the Claude-style "● agent finished" update the user asked for. `✓ name — <one
 * line>` on success, `✗ name — <reason>` on failure; the summary is reduced to
 * its first non-empty line and clipped, so the rail gets ONE tidy update per
 * lead, never a wall of the agent's full prose (that streams in the orchestrator's
 * own voice + the fleet tree). Workers (non-top-level) are the lead's concern and
 * surface only in the tree, so the root rail stays uncluttered. Pure + testable;
 * matches the `gate` rail line's glyph convention.
 */
export const fleetCompletionLine = (name: string, ok: boolean, summary: string): string => {
  const mark = ok ? "✓" : "✗"
  const firstLine =
    summary
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  const clipped = firstLine.length > 100 ? `${firstLine.slice(0, 99)}…` : firstLine
  return clipped.length > 0 ? `${mark} ${name} — ${clipped}` : `${mark} ${name}`
}

/** The fleet chip: `2 agents · haiku, audit` (names clipped to fit). */
export const fleetLabel = (s: AgentState, maxNames = 2): string | undefined => {
  if (s.fleet.length === 0) return undefined
  const names = s.fleet.slice(0, maxNames).map((m) => m.name)
  const more = s.fleet.length - names.length
  const suffix = more > 0 ? ` +${more}` : ""
  return `${s.fleet.length} agent${s.fleet.length === 1 ? "" : "s"} · ${names.join(", ")}${suffix}`
}
