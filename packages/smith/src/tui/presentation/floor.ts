import { Match, Option } from "effect"
import type { SmithEvent } from "../../domain/SmithEvent.js"
import { agentEventLabel, clip } from "../../presentation/eventLines.js"

export type GateCellState = "pending" | "running" | "pass" | "fail" | "skip"

export interface GateCell {
  readonly name: string
  readonly state: GateCellState
  readonly findings: number
}

export interface AttemptRow {
  readonly attempt: number
  readonly gates: ReadonlyArray<GateCell>
  readonly files: number
}

export type FloorPhase = "boot" | "implementing" | "gating" | "done" | "failed"

/**
 * The factory floor — ONE immutable view model the whole TUI reads, folded
 * from the smith event stream by {@link reduceFloor} (pure, Match.exhaustive;
 * the Solid layer just holds the latest value in a signal).
 */
export interface FloorState {
  readonly task: string
  readonly maxAttempts: number
  readonly gateNames: ReadonlyArray<string>
  readonly attempts: ReadonlyArray<AttemptRow>
  readonly phase: FloorPhase
  /** Rolling live-activity labels (agent tool calls, spawns, retries). */
  readonly feed: ReadonlyArray<string>
  /** The latest failed report's finding lines (plain text, no ANSI). */
  readonly findings: ReadonlyArray<string>
  readonly outcome: Option.Option<string>
  readonly artifact: Option.Option<string>
  readonly conversationRef: Option.Option<string>
  readonly error: Option.Option<string>
}

const FEED_CAP = 200
const FINDINGS_CAP = 12

export const initialFloor = (task: string, maxAttempts: number): FloorState => ({
  task,
  maxAttempts,
  gateNames: [],
  attempts: [],
  phase: "boot",
  feed: [],
  findings: [],
  outcome: Option.none(),
  artifact: Option.none(),
  conversationRef: Option.none(),
  error: Option.none(),
})

const pendingRow = (attempt: number, gateNames: ReadonlyArray<string>): AttemptRow => ({
  attempt,
  gates: gateNames.map((name) => ({ name, state: "pending" as const, findings: 0 })),
  files: 0,
})

const updateCurrentRow = (
  state: FloorState,
  update: (row: AttemptRow) => AttemptRow,
): FloorState => ({
  ...state,
  attempts: state.attempts.map((row, index) =>
    index === state.attempts.length - 1 ? update(row) : row,
  ),
})

const findingLine = (finding: {
  readonly rule: string
  readonly message: string
  readonly location: Option.Option<{ readonly file: string; readonly line: number }>
}): string => {
  const where = Option.match(finding.location, {
    onNone: () => "",
    onSome: (l) => `${l.file}:${l.line} `,
  })
  return `[${finding.rule}] ${where}${clip(finding.message, 110)}`
}

/** Fold one smith event into the floor. Pure — unit-tested without Solid.
 *  Refine-phase events are inert here (the refine reducer owns them). */
export const reduceFloor = (state: FloorState, event: SmithEvent): FloorState =>
  Match.value(event).pipe(
    Match.when({ type: "refine_start" }, () => state),
    Match.when({ type: "spec_draft" }, () => state),
    Match.when({ type: "spec_locked" }, () => state),
    Match.when({ type: "refine_error" }, () => state),
    Match.when({ type: "forge_start" }, (e) => ({
      ...state,
      gateNames: e.gateNames,
      task: e.spec.goal,
      maxAttempts: e.spec.limits.maxAttempts,
    })),
    Match.when({ type: "attempt_start" }, (e) => ({
      ...state,
      phase: "implementing" as const,
      findings: [],
      attempts: [...state.attempts, pendingRow(e.attempt, state.gateNames)],
    })),
    Match.when({ type: "implement_end" }, (e) =>
      updateCurrentRow(
        { ...state, phase: "gating" as const, conversationRef: e.ref },
        (row) => ({ ...row, files: e.filesTouched.length }),
      ),
    ),
    Match.when({ type: "gate_start" }, (e) =>
      updateCurrentRow({ ...state, phase: "gating" as const }, (row) => ({
        ...row,
        gates: row.gates.map((cell) =>
          cell.name === e.gate ? { ...cell, state: "running" as const } : cell,
        ),
      })),
    ),
    Match.when({ type: "gate_report" }, (e) => {
      const byGate = new Map(
        e.report.verdicts.map((verdict) => [String(verdict.gate), verdict]),
      )
      const next = updateCurrentRow(state, (row) => ({
        ...row,
        gates: row.gates.map((cell) => {
          const verdict = byGate.get(cell.name)
          if (verdict === undefined) return cell
          return Match.value(verdict).pipe(
            Match.tag("pass", (v) => ({
              ...cell,
              state: "pass" as const,
              findings: v.findings.length,
            })),
            Match.tag("fail", (v) => ({
              ...cell,
              state: "fail" as const,
              findings: v.findings.length,
            })),
            Match.tag("skip", () => ({ ...cell, state: "skip" as const })),
            Match.exhaustive,
          )
        }),
      }))
      const findings = e.report.failures
        .flatMap((failure) => failure.findings)
        .slice(0, FINDINGS_CAP)
        .map((finding) =>
          findingLine({
            rule: String(finding.rule),
            message: finding.message,
            location: Option.map(finding.location, (l) => ({
              file: String(l.file),
              line: l.line,
            })),
          }),
        )
      return { ...next, findings }
    }),
    Match.when({ type: "forge_end" }, (e) => ({
      ...state,
      phase: "done" as const,
      outcome: Option.some(
        e.run.outcome._tag === "accepted"
          ? `accepted (attempt ${e.run.outcome.attempt})`
          : `rejected — ${e.run.outcome.reason}`,
      ),
      artifact: Option.some(e.artifact),
    })),
    Match.when({ type: "forge_error" }, (e) => ({
      ...state,
      phase: "failed" as const,
      error: Option.some(e.message),
    })),
    Match.when({ type: "agent" }, (e) =>
      Option.match(agentEventLabel(e), {
        onNone: () => state,
        onSome: (label) => ({
          ...state,
          feed: [...state.feed, label].slice(-FEED_CAP),
        }),
      }),
    ),
    Match.exhaustive,
  )
