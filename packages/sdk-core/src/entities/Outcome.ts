import { Schema } from "effect"
// Type-only: keeps this module runtime-dependency-free so `AgentContext.ts` can
// import the StopReason schema VALUE without a module cycle.
import type { ContextUsage } from "./AgentContext.js"

/**
 * The honest outcome vocabulary — how ANY agent run (root turn or spawned node)
 * ended, carried on the ONE terminal path (`finalizeRun`) and persisted with the
 * node. The old vocabulary collapsed everything to ok/error, which is how a
 * budget-stopped run masqueraded as success (25× in the run forensics) and a
 * watchdog kill read identically to a real failure.
 *
 *  - `ok`      — completed normally; the summary is the deliverable.
 *  - `partial` — a deliverable EXISTS but the run stopped early (budget /
 *    step-cap / degenerate-loop breaker / a stall after producing text). Usable,
 *    not complete — the parent and the UI must say so.
 *  - `error`   — the run itself failed (provider defect, tool escalation, …).
 *  - `killed`  — it never reached a terminal path: interrupted (human / parent /
 *    shutdown / deadline) or stalled with nothing produced.
 */
export const OutcomeStatus = Schema.Literal("ok", "partial", "error", "killed")
export type OutcomeStatus = typeof OutcomeStatus.Type

/** Provider-defect classes (see `classifyProviderError` in sdk-adapters):
 *  `transient` retries; the rest fail fast carrying the class so the router can
 *  fail over (`quota`/`config`/`model`) or surface a login hint (`auth`). */
export const ProviderDefectClass = Schema.Literal(
  "transient",
  "quota",
  "config",
  "auth",
  "model",
)
export type ProviderDefectClass = typeof ProviderDefectClass.Type

/**
 * WHY a run stopped — the typed reason behind an {@link OutcomeStatus}. The
 * `kind` doubles as the compact wire label on `subagent_end` / `agent_end`
 * events; the extra fields carry the diagnosis (who interrupted, which provider
 * class, the underlying error tag).
 */
export const StopReason = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("completed") }),
  Schema.Struct({ kind: Schema.Literal("budget") }),
  Schema.Struct({ kind: Schema.Literal("step-cap") }),
  Schema.Struct({ kind: Schema.Literal("degenerate-loop") }),
  Schema.Struct({
    kind: Schema.Literal("stall"),
    idleMs: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("interrupt"),
    by: Schema.Literal("human", "parent", "shutdown", "deadline"),
  }),
  Schema.Struct({
    kind: Schema.Literal("provider"),
    class: ProviderDefectClass,
    message: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("error"),
    error: Schema.String,
    message: Schema.optional(Schema.String),
  }),
)
export type StopReason = typeof StopReason.Type
export type StopReasonKind = StopReason["kind"]

/** The compact wire label for a StopReason — what rides on `subagent_end` /
 *  `agent_end` events (the full typed reason lives on the persisted node). */
export const StopReasonKindSchema = Schema.Literal(
  "completed",
  "budget",
  "step-cap",
  "degenerate-loop",
  "stall",
  "interrupt",
  "provider",
  "error",
)

/**
 * The complete terminal record of one run — computed by whichever exit shape
 * ended it and handed to `finalizeRun`, which records + notifies + emits it
 * exactly once. `summary` ALWAYS carries the run's last assistant text when any
 * exists (a killed run's produced work is never discarded); `notes` carries loud
 * annotations (model failovers, gate degradation) that must survive into the
 * persisted record.
 */
export interface RunOutcome {
  readonly status: OutcomeStatus
  readonly summary: string
  readonly filesChanged: ReadonlyArray<string>
  readonly reason: StopReason
  readonly usage?: ContextUsage
  readonly notes?: ReadonlyArray<string>
}

/**
 * The one status-mapping rule (the honesty table):
 * completed → ok · budget/step-cap/degenerate → partial · stall WITH produced
 * text → partial (the thinking finished; the caveat rides the summary), stall
 * with nothing → killed · interrupt → killed · provider/error → error.
 */
export const outcomeStatus = (
  reason: StopReason,
  hasText: boolean,
): OutcomeStatus => {
  switch (reason.kind) {
    case "completed":
      return "ok"
    case "budget":
    case "step-cap":
    case "degenerate-loop":
      return "partial"
    case "stall":
      return hasText ? "partial" : "killed"
    case "interrupt":
      return "killed"
    case "provider":
    case "error":
      return "error"
  }
}

/** `true` when the outcome still carries a usable deliverable (ok or partial) —
 *  the legacy boolean consumers keyed `subagent_end.ok` on. */
export const outcomeOk = (status: OutcomeStatus): boolean =>
  status === "ok" || status === "partial"

/** Encode a StopReason for the DB's `stop_reason` JSON column. */
export const encodeStopReason = (reason: StopReason): string =>
  JSON.stringify(reason)

/** Best-effort decode of a persisted `stop_reason` — absent/corrupt ⇒ undefined
 *  (a node written before the column existed must still load). */
export const decodeStopReason = (raw: unknown): StopReason | undefined => {
  if (typeof raw !== "string" || raw.length === 0) return undefined
  const parsed = Schema.decodeUnknownOption(Schema.parseJson(StopReason))(raw)
  return parsed._tag === "Some" ? parsed.value : undefined
}
