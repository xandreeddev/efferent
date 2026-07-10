import { Option } from "effect"

/**
 * The composer's prompt ring — session-local ↑/↓ recall, shell-style. Pure:
 * the key layer owns wiring; the ring never touches what the user is
 * actively editing (recall only engages on an EMPTY composer or while the
 * composer still shows the recalled entry verbatim — one keystroke of
 * editing detaches it).
 */

const HISTORY_CAP = 50

export interface HistoryState {
  readonly entries: ReadonlyArray<string>
  /** The recall position while navigating; None = not recalling. */
  readonly cursor: Option.Option<number>
}

export const initialHistory: HistoryState = { entries: [], cursor: Option.none() }

/** Every submitted prompt lands here (consecutive duplicates collapse). */
export const pushHistory = (state: HistoryState, text: string): HistoryState => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ...state, cursor: Option.none() }
  const entries =
    state.entries[state.entries.length - 1] === trimmed
      ? state.entries
      : [...state.entries, trimmed].slice(-HISTORY_CAP)
  return { entries, cursor: Option.none() }
}

export interface Recall {
  readonly state: HistoryState
  /** What the composer should show now. */
  readonly text: string
}

/**
 * One ↑/↓ step. `None` = the key is not ours (composer mid-edit, or nothing
 * to recall) — the caller lets the key fall through.
 */
export const recallStep = (
  state: HistoryState,
  direction: "up" | "down",
  composer: string,
): Option.Option<Recall> => {
  const engaged = Option.match(state.cursor, {
    // Fresh recall: only from an EMPTY composer, only upward.
    onNone: () =>
      direction === "up" && composer.trim().length === 0 && state.entries.length > 0
        ? Option.some(state.entries.length - 1)
        : Option.none<number>(),
    // Continuing: only while the composer still shows the recalled entry.
    onSome: (at) =>
      composer === state.entries[at]
        ? direction === "up"
          ? Option.some(Math.max(0, at - 1))
          : Option.some(at + 1)
        : Option.none<number>(),
  })
  return Option.map(engaged, (at) =>
    at >= state.entries.length
      ? { state: { ...state, cursor: Option.none() }, text: "" }
      : { state: { ...state, cursor: Option.some(at) }, text: state.entries[at] ?? "" },
  )
}
