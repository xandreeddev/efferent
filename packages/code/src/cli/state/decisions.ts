import { createSignal, type Accessor } from "solid-js"

/**
 * One pending human decision — the UI projection of a `needs_human` event. The
 * control plane raises two shapes onto the SAME channel (see `AgentEvent`):
 *
 *  - `parked: false` — an INTERACTIVE run opened a prompt; the approval sheet
 *    already handles the live ask, so this entry is the roster mirror.
 *  - `parked: true`  — an UNATTENDED (headless/scheduled) run hit something the
 *    auto-approval judge wouldn't wave through, recorded the need, and
 *    denied-with-reason. Nobody was watching; a human attaching later must SEE
 *    these pending decisions.
 *
 * `sessionId`/`nodeId`/`tool`/`folder` are the attribution (which agent, where);
 * `summary`/`reason` are what to surface. `id` is this entry's stable cache
 * identity (see {@link decisionId}) so a repeated ask upserts in place.
 */
export interface Decision {
  readonly id: string
  readonly sessionId?: string
  readonly nodeId?: string
  readonly tool?: string
  readonly summary: string
  readonly reason: string
  readonly folder?: string
  readonly parked: boolean
}

/**
 * A decision's stable identity for de-dupe: session (or `root` when absent) +
 * its summary. A re-emitted ask for the same thing in the same session
 * therefore upserts onto the existing entry instead of stacking a duplicate —
 * the same keyed-cache discipline the conversation rail uses.
 */
export const decisionId = (d: {
  sessionId?: string | undefined
  summary: string
}): string => `${d.sessionId ?? "root"}::${d.summary}`

/**
 * Pending-human-decisions slice: a small keyed list surfaced as a compact roster
 * in the bottom chrome. Writers (the event pump) `pushDecision`; the human (or a
 * session-resolved event) `dismissDecision`s one or `clearSession`s a whole
 * session's parked decisions when its run is re-run/resolved. Purely
 * presentational — nothing here crosses into Effect.
 */
export interface DecisionsSlice {
  readonly decisions: Accessor<ReadonlyArray<Decision>>
  /** Upsert a decision by {@link decisionId} (de-dupes a repeated ask). */
  readonly pushDecision: (decision: Decision) => void
  /** Drop one decision by its id (manual dismiss). */
  readonly dismissDecision: (id: string) => void
  /**
   * Drop every PARKED decision for a session — cheap auto-clear when that
   * session is resolved/re-run (an `approval_resolved` lands, or the human
   * resumes it). Interactive (`parked: false`) entries are left for the sheet's
   * own resolve path; absent `sessionId` matches the `root` bucket.
   */
  readonly clearSession: (sessionId: string | undefined) => void
}

export const createDecisionsSlice = (): DecisionsSlice => {
  const [decisions, setDecisions] = createSignal<ReadonlyArray<Decision>>([])

  return {
    decisions,
    pushDecision: (decision) =>
      setDecisions((ds) => {
        const at = ds.findIndex((d) => d.id === decision.id)
        if (at === -1) return [...ds, decision]
        const next = [...ds]
        next[at] = decision
        return next
      }),
    dismissDecision: (id) => setDecisions((ds) => ds.filter((d) => d.id !== id)),
    clearSession: (sessionId) => {
      const bucket = sessionId ?? "root"
      setDecisions((ds) =>
        ds.filter((d) => !(d.parked && (d.sessionId ?? "root") === bucket)),
      )
    },
  }
}
