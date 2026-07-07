/**
 * AgentEvent → MathModel reducer — the GENERATION side of the model (the
 * grading side folds through `pump.apply` from the typed-action handlers).
 * Small on purpose: math has no chat rail, no canvas, no approval sheet
 * (bash is off), so most events are no-ops.
 */
import type { MathSessionEvent } from "../session.js"
import {
  ALL_PATCHES,
  putItems,
  setError,
  setGenerating,
  type MathModel,
  type MathPatch,
} from "./model.js"

export interface MathReduced {
  readonly model: MathModel
  readonly patches: ReadonlyArray<MathPatch>
}

const same = (model: MathModel): MathReduced => ({ model, patches: [] })

export const reduceMathEvent = (m: MathModel, event: MathSessionEvent): MathReduced => {
  switch (event.type) {
    case "math_render":
      return { model: putItems(m, event.items), patches: ALL_PATCHES }

    case "turn_start":
      // A turn is running — the topbar pulses, the agent buttons freeze. Only
      // the FIRST turn of a run changes anything visible.
      return m.generating
        ? same(m)
        : { model: setGenerating(m, true), patches: ["header", "controls", ...(m.currentId === undefined ? (["stage"] as const) : [])] }

    case "agent_end": {
      // A generation run that produced NOTHING while the student was waiting on
      // a skeleton is a failure the UI must say out loud — never a silent blank.
      const emptyWhileWaiting =
        m.generating && m.acceptedThisTurn === 0 && m.currentId === undefined && m.started
      const model = emptyWhileWaiting
        ? setError(
            m,
            "The tutor finished without writing any exercises.",
            event.finalText.trim().slice(0, 300),
          )
        : setGenerating(m, false)
      return { model, patches: ["header", "controls", ...(emptyWhileWaiting ? (["stage"] as const) : [])] }
    }

    case "error":
      return {
        model: m.currentId === undefined && m.started ? setError(m, "The tutor hit a snag.", event.message) : setGenerating(m, false),
        patches: ["header", "controls", ...(m.currentId === undefined && m.started ? (["stage"] as const) : [])],
      }

    // Everything else — chat narration, tool pills, sub-agent machinery,
    // approvals (bash is off), retries (the pulse already shows work), board
    // notes — has no math surface to land on.
    default:
      return same(m)
  }
}
