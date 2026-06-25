import { Schema } from "effect"
import type { AgentEvent } from "./AgentEvent.js"

/**
 * The agent's coarse **lifecycle phase** — *what is the root turn doing right
 * now*, derived purely from the `AgentEvent` stream:
 *
 *   idle ──turn/tool──▶ thinking ──tool start──▶ tool ──last tool end──▶ thinking
 *     ▲                                                                    │
 *     └──────────────────── agent_end / error ◀────────────────────────--─┘
 *
 * This lives in core (not the CLI) because BOTH halves of the daemon split need
 * it: the daemon FOLDS every published root event through {@link reducePhase}
 * into the authoritative `SessionState.phase`, and the client reconciles its own
 * richer `agentState` machine against that phase on (re)attach + resync — so a
 * client that joins mid-turn shows `thinking`, and an idle daemon clears a stale
 * `thinking` spinner instead of leaving it stuck.
 *
 * It is deliberately the SUBSET the wire needs: just the phase + the open root
 * tool count (so the last tool's end can fall back to `thinking`). The CLI's
 * `agentState.ts` keeps the richer per-tool-label + fleet state and reuses this
 * `AgentPhase` literal + transition rules verbatim, so the two never drift.
 *
 * Only ROOT events move the phase: a sub-agent's inner events carry a `nodeId`
 * and belong to the orthogonal fleet, and `run_agent` itself is skipped (its
 * lifetime IS the fleet membership). Events that aren't lifecycle-relevant
 * (`assistant_message`, `skill_load`, `board_note`, …) leave the phase as-is.
 */
export const AgentPhase = Schema.Literal("idle", "thinking", "tool")
export type AgentPhase = typeof AgentPhase.Type

/** The minimal phase-derivation state the daemon folds events into. */
export interface PhaseState {
  readonly phase: AgentPhase
  /** Open ROOT tool calls (sub-agent inner tools are excluded). */
  readonly openToolCount: number
}

export const initialPhaseState: PhaseState = { phase: "idle", openToolCount: 0 }

/** A user just submitted — thinking until the loop says otherwise. */
export const submittedPhaseState: PhaseState = { phase: "thinking", openToolCount: 0 }

/**
 * Fold one `AgentEvent` into the phase state. Pure; the SAME transition rules the
 * CLI's `reduceAgentState` applies, so the daemon's derived phase and the
 * client's machine agree event-for-event.
 */
export const reducePhase = (s: PhaseState, e: AgentEvent): PhaseState => {
  switch (e.type) {
    case "turn_start":
      // A new model call: tools from the previous turn are settled.
      return { phase: "thinking", openToolCount: 0 }
    case "tool_call_start": {
      if (e.nodeId !== undefined) return s // a fleet member's inner tool
      if (e.toolName === "run_agent") return s // its lifetime IS the fleet
      return { phase: "tool", openToolCount: s.openToolCount + 1 }
    }
    case "tool_call_end": {
      if (e.nodeId !== undefined || e.toolName === "run_agent") return s
      const open = Math.max(0, s.openToolCount - 1)
      // Last root tool settled → the model reads results: thinking again.
      return { phase: open === 0 ? "thinking" : s.phase, openToolCount: open }
    }
    case "agent_end":
    case "error":
      // The root turn ended — its background fleet runs on, but the ROOT phase
      // (all this carries) is idle.
      return initialPhaseState
    default:
      return s
  }
}

/** Fold a whole event sequence — the daemon seeds from this on rebuild, tests use it. */
export const derivePhase = (events: ReadonlyArray<AgentEvent>): PhaseState =>
  events.reduce(reducePhase, initialPhaseState)
