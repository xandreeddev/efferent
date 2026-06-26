/**
 * Pure prompt-history model — readline-style ↑/↓ recall of previously-sent
 * messages, with no Solid or OpenTUI. The view holds one of these in a signal and
 * applies the returned `text` to the input on each recall.
 *
 * `entries` is oldest→newest. `pos` is the index currently being browsed, or
 * `null` when the buffer holds the user's own draft (not a recalled entry).
 * `draft` stashes that in-progress draft when browsing begins, so ↓ past the
 * newest entry restores it instead of losing it.
 */
export interface PromptHistory {
  readonly entries: ReadonlyArray<string>
  readonly pos: number | null
  readonly draft: string
}

export const emptyHistory: PromptHistory = { entries: [], pos: null, draft: "" }

/**
 * Record a submitted prompt as the newest entry and stop browsing. Consecutive
 * duplicates and blank submissions are ignored (they'd just be noise on ↑).
 */
export const pushPrompt = (h: PromptHistory, text: string): PromptHistory => {
  const t = text.trim()
  if (t.length === 0) return { ...h, pos: null, draft: "" }
  if (h.entries[h.entries.length - 1] === t) return { ...h, pos: null, draft: "" }
  return { entries: [...h.entries, t], pos: null, draft: "" }
}

/** The buffer text for a browse position (`null` ⇒ the stashed draft). */
const textAt = (h: PromptHistory, pos: number | null): string =>
  pos === null ? h.draft : (h.entries[pos] ?? h.draft)

/**
 * ↑ — recall an older entry. The first press (from a draft) stashes `current` as
 * the draft and jumps to the newest entry; further presses step toward the
 * oldest. Returns the next state + the text to show, or `undefined` when there's
 * nothing older (empty history, or already at the oldest entry).
 */
export const historyPrev = (
  h: PromptHistory,
  current: string,
): { readonly history: PromptHistory; readonly text: string } | undefined => {
  if (h.entries.length === 0) return undefined
  if (h.pos === null) {
    const pos = h.entries.length - 1
    const next: PromptHistory = { ...h, pos, draft: current }
    return { history: next, text: textAt(next, pos) }
  }
  if (h.pos === 0) return undefined // already at the oldest
  const pos = h.pos - 1
  return { history: { ...h, pos }, text: textAt(h, pos) }
}

/**
 * ↓ — move toward newer entries. Past the newest entry, browsing ends and the
 * stashed draft returns (`pos` → `null`). Returns `undefined` when not browsing
 * (nothing to come back to).
 */
export const historyNext = (
  h: PromptHistory,
): { readonly history: PromptHistory; readonly text: string } | undefined => {
  if (h.pos === null) return undefined
  if (h.pos >= h.entries.length - 1) {
    const next: PromptHistory = { ...h, pos: null }
    return { history: next, text: h.draft }
  }
  const pos = h.pos + 1
  return { history: { ...h, pos }, text: textAt(h, pos) }
}
