import { Option } from "effect"
import type { FloorState } from "./floor.js"
import type { RefineState } from "./refine.js"

/**
 * The flow stepper — WHERE the session is in the pipeline, as one glanceable
 * column: refine → :lock → forge → gates → result. The side panel showed
 * artifacts (a draft, some gate cells) but never the journey, so "what phase
 * am I in, what happens next" needed reverse-engineering (live complaint).
 * Pure view model; the Solid layer renders it verbatim.
 */

export interface FlowStep {
  readonly label: string
  readonly state: "done" | "current" | "pending"
  readonly detail: string
}

const gateTally = (floor: FloorState): string => {
  const gates = floor.attempts[floor.attempts.length - 1]?.gates ?? []
  const pass = gates.filter((g) => g.state === "pass").length
  const fail = gates.filter((g) => g.state === "fail").length
  return `✓${pass} ✗${fail} of ${gates.length}`
}

export const flowView = (
  mode: "idle" | "refine" | "forge",
  refine: RefineState,
  floor: FloorState,
): ReadonlyArray<FlowStep> => {
  const forging = mode === "forge"
  const draft = Option.isSome(refine.draft)
  const locked = refine.locked
  const ended = floor.phase === "done" || floor.phase === "failed"
  const attempt = Math.max(floor.attempts.length, 1)
  return [
    {
      label: "refine",
      state: forging || locked ? "done" : "current",
      detail:
        forging || locked
          ? "spec shaped"
          : draft
            ? "draft up — iterate in the composer"
            : "exploring the workspace…",
    },
    {
      label: "lock",
      state: locked || forging ? "done" : "pending",
      detail:
        locked || forging
          ? "locked by you"
          : draft
            ? ":lock when the spec is right"
            : "only you can lock",
    },
    {
      label: "forge",
      state:
        forging && floor.phase === "implementing"
          ? "current"
          : forging && (floor.phase === "gating" || ended)
            ? "done"
            : "pending",
      detail: forging
        ? `attempt ${attempt}/${floor.maxAttempts}`
        : locked
          ? ":forge to build"
          : "after the lock",
    },
    {
      label: "gates",
      state: floor.phase === "gating" ? "current" : ended ? "done" : "pending",
      detail:
        floor.phase === "gating" || ended
          ? gateTally(floor)
          : forging && floor.gateNames.length > 0
            ? `${floor.gateNames.length} gate(s) armed`
            : "the gates judge, not the model",
    },
    {
      label: "result",
      state: ended ? "done" : "pending",
      detail: Option.getOrElse(floor.outcome, () =>
        Option.match(floor.error, {
          onNone: () => "accepted or rejected — exit codes are honest",
          onSome: (message) => message,
        }),
      ),
    },
  ]
}
