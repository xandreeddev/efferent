import type { AgentEvent } from "../events.js"

/**
 * Pure fold of a headless run's event stream into process-exit honesty. The
 * old print/json modes ALWAYS exited 0 — a run whose agents all died, whose
 * root was killed, or whose gate was bypassed looked identical to a clean one
 * to any script wrapping the CLI. This makes the exit code + stderr notes carry
 * the truth:
 *
 *   exit 1 — an `error` event fired, or the root turn ended error/killed;
 *   exit 0 + notes — partial results (budget/step-cap), failed sub-agents on an
 *     otherwise-delivered run, gate degradation (unavailable/blocked) — the
 *     deliverable exists, the caveats go to stderr.
 */
export interface OutcomeFold {
  readonly errored: boolean
  /** The LAST root agent_end's outcome (gate retries emit several — the final
   *  one is the delivered turn). Absent from legacy emitters ⇒ ok. */
  readonly rootOutcome?: "ok" | "partial" | "error" | "killed"
  readonly rootReason?: string
  /** `name — reason` lines for sub-agents that ended error/killed. */
  readonly failedAgents: ReadonlyArray<string>
  /** `name — reason` lines for sub-agents that ended partial. */
  readonly partialAgents: ReadonlyArray<string>
  /** Gate degradation notes (unavailable / blocked / advisory-delivered). */
  readonly gateNotes: ReadonlyArray<string>
}

export const initialOutcomeFold: OutcomeFold = {
  errored: false,
  failedAgents: [],
  partialAgents: [],
  gateNotes: [],
}

export const foldOutcomeEvent = (f: OutcomeFold, e: AgentEvent): OutcomeFold => {
  switch (e.type) {
    case "error":
      return { ...f, errored: true }
    case "agent_end":
      return {
        ...f,
        rootOutcome: e.outcome ?? "ok",
        ...(e.reason !== undefined ? { rootReason: e.reason } : {}),
      }
    case "subagent_end": {
      const outcome = e.outcome ?? (e.ok ? "ok" : "error")
      const line = `${e.name} — ${e.reason ?? outcome}`
      if (outcome === "error" || outcome === "killed") {
        return { ...f, failedAgents: [...f.failedAgents, line] }
      }
      if (outcome === "partial") {
        return { ...f, partialAgents: [...f.partialAgents, line] }
      }
      return f
    }
    case "gate": {
      if (e.verdict === "unavailable") {
        return {
          ...f,
          gateNotes: [...f.gateNotes, "verifier UNAVAILABLE — the work was NOT verified"],
        }
      }
      if (e.verdict === "blocked") {
        return {
          ...f,
          gateNotes: [...f.gateNotes, `verifier BLOCKED: ${e.reasons.join("; ")}`],
        }
      }
      if (e.verdict === "needs_work" && e.advisory === true) {
        return {
          ...f,
          gateNotes: [
            ...f.gateNotes,
            `delivered with reviewer notes: ${e.reasons.join("; ")}`,
          ],
        }
      }
      return f
    }
    default:
      return f
  }
}

/** 1 iff the run itself failed; partials and failed sub-agents on a delivered
 *  run stay 0 (the deliverable exists — the notes carry the caveats). */
export const outcomeExitCode = (f: OutcomeFold): 0 | 1 =>
  f.errored || f.rootOutcome === "error" || f.rootOutcome === "killed" ? 1 : 0

/** Human-readable stderr caveats — empty for a clean run. */
export const outcomeNotes = (f: OutcomeFold): ReadonlyArray<string> => [
  ...(f.rootOutcome === "partial"
    ? [`result is PARTIAL (${f.rootReason ?? "stopped early"})`]
    : []),
  ...f.partialAgents.map((a) => `partial agent: ${a}`),
  ...f.failedAgents.map((a) => `failed agent: ${a}`),
  ...f.gateNotes,
]
