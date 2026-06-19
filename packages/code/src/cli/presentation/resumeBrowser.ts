import type { ConvSummary, NamedConn } from "@xandreed/sdk-core"

/**
 * Pure state for the agy-style **tabbed resume browser** (`:resume` / `:browse`):
 * one tab per configured database connection, each holding that DB's
 * conversations for the workspace (loaded by the action via
 * `StoreSwitch.listSessions`). Tab/←→ cycle connections, ↑/↓ move the row, typing
 * filters the active tab's list, ↵ resumes (switching the live store first when
 * the pick lives in a non-active connection). No IO here — reducers only.
 */

/** One connection's tab: its conversations, or an error if the DB wouldn't open. */
export interface ResumeTab {
  readonly conn: NamedConn
  /** Display label, e.g. `local (sqlite)`. */
  readonly label: string
  /** True for the currently-active store (marked in the tab strip). */
  readonly active: boolean
  readonly convs: ReadonlyArray<ConvSummary>
  /** Set when `listSessions` failed (e.g. an unreachable remote) — shown in place
   *  of the list so the tab still renders. */
  readonly error?: string | undefined
}

export interface ResumeState {
  readonly tabs: ReadonlyArray<ResumeTab>
  /** Index into `tabs` (the visible connection). */
  readonly tab: number
  readonly filter: string
  /** Index into the active tab's FILTERED conversations. */
  readonly selected: number
}

/** Open at the active connection's tab (so the current DB is what you see first). */
export const openResume = (tabs: ReadonlyArray<ResumeTab>): ResumeState => {
  const activeIdx = tabs.findIndex((t) => t.active)
  return { tabs, tab: activeIdx >= 0 ? activeIdx : 0, filter: "", selected: 0 }
}

/** The visible tab, or undefined when there are no connections at all. */
export const activeTab = (s: ResumeState): ResumeTab | undefined => s.tabs[s.tab]

/** The active tab's conversations narrowed by the filter (title / first prompt,
 *  case-insensitive). */
export const filteredConvs = (s: ResumeState): ReadonlyArray<ConvSummary> => {
  const tab = activeTab(s)
  if (tab === undefined) return []
  const q = s.filter.trim().toLowerCase()
  if (q.length === 0) return tab.convs
  return tab.convs.filter((c) =>
    `${c.title ?? ""} ${c.firstPrompt ?? ""}`.toLowerCase().includes(q),
  )
}

const clamp = (n: number, max: number): number => (max <= 0 ? 0 : Math.max(0, Math.min(n, max - 1)))

/** Move the row cursor within the active tab's filtered list (wraps). */
export const resumeMove = (s: ResumeState, dir: "up" | "down"): ResumeState => {
  const n = filteredConvs(s).length
  if (n === 0) return { ...s, selected: 0 }
  const next = dir === "up" ? (s.selected - 1 + n) % n : (s.selected + 1) % n
  return { ...s, selected: next }
}

/** Switch the visible connection tab (wraps); resets the row cursor + filter so
 *  each tab opens clean (agy clears the search when you switch tabs). */
export const resumeCycleTab = (s: ResumeState, dir: "left" | "right"): ResumeState => {
  const n = s.tabs.length
  if (n <= 1) return s
  const tab = dir === "left" ? (s.tab - 1 + n) % n : (s.tab + 1) % n
  return { ...s, tab, filter: "", selected: 0 }
}

export const resumeFilterAppend = (s: ResumeState, ch: string): ResumeState => {
  const next = { ...s, filter: s.filter + ch }
  return { ...next, selected: clamp(s.selected, filteredConvs(next).length) }
}

export const resumeFilterBackspace = (s: ResumeState): ResumeState => {
  const next = { ...s, filter: s.filter.slice(0, -1) }
  return { ...next, selected: clamp(s.selected, filteredConvs(next).length) }
}

/** Clear the filter (esc step 1 — "Clear search"); returns undefined if there was
 *  nothing to clear (so the caller closes the browser instead). */
export const resumeClearFilter = (s: ResumeState): ResumeState | undefined =>
  s.filter.length === 0 ? undefined : { ...s, filter: "", selected: 0 }

/** The conversation under the cursor + its connection, for ↵ resume. */
export const selectedResume = (
  s: ResumeState,
): { readonly conv: ConvSummary; readonly conn: NamedConn; readonly active: boolean } | undefined => {
  const tab = activeTab(s)
  if (tab === undefined) return undefined
  const conv = filteredConvs(s)[s.selected]
  if (conv === undefined) return undefined
  return { conv, conn: tab.conn, active: tab.active }
}
