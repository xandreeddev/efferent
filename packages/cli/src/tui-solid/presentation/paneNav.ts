/**
 * Shared row-cursor navigation — the pure motion math behind the vim-style
 * cursor in both read-only panes. A pane flattens its content into an ordered
 * list of {@link NavRow}s (the context viewer, the Activity stack, the
 * conversation rail all do this); these helpers move a cursor index over that
 * list and toggle the row-under-cursor's fold id. No Solid, no OpenTUI, no key
 * types — this is L1 and stays import-free of the driver layers (the keystroke →
 * motion mapping lives in `keys/`).
 *
 * Two granularities: `stepRow` is the paragraph step (`{`/`}` — one row at a
 * time); `stepHead` is the message step (`[`/`]` — jump to the next row that
 * starts a logical unit, flagged `head`). In a single-line-per-row pane (the
 * side pane) `stepRow` is also the plain `j`/`k` move.
 */
export interface NavRow {
  /** Stable id — the rendered box's `id`, for cursor tint + scroll-into-view. */
  readonly key: string
  /** Fold target toggled by `⇥`/`↵`; absent ⇒ the row isn't foldable. */
  readonly foldId?: string
  /** True ⇒ this row starts a top-level unit (a `[`/`]` message stop). */
  readonly head?: boolean
}

/** Clamp a cursor into `[0, len)`, collapsing an empty list to 0. */
export const clampCursor = (len: number, cursor: number): number =>
  len === 0 ? 0 : Math.max(0, Math.min(cursor, len - 1))

/** `{`/`}` — paragraph step: move the cursor by `delta` rows, clamped. Also the
 *  plain `j`/`k` move where every row is a single line. */
export const stepRow = <R>(rows: ReadonlyArray<R>, cursor: number, delta: number): number =>
  clampCursor(rows.length, cursor + delta)

/** `[`/`]` — message step: jump to the next/prev row flagged `head`. Stays put
 *  when there's no further head in that direction. */
export const stepHead = <R extends { readonly head?: boolean }>(
  rows: ReadonlyArray<R>,
  cursor: number,
  dir: 1 | -1,
): number => {
  if (rows.length === 0) return 0
  const start = clampCursor(rows.length, cursor)
  for (let i = start + dir; i >= 0 && i < rows.length; i += dir) {
    if (rows[i]?.head === true) return i
  }
  return start
}

/** `gg` — cursor to the first row. */
export const rowToTop = (): number => 0
/** `G` — cursor to the last row. */
export const rowToEnd = <R>(rows: ReadonlyArray<R>): number => Math.max(0, rows.length - 1)

/**
 * `⇥`/`↵` — toggle the fold id of the row under the cursor in `collapsed`,
 * returning a new set. No-op (returns the same set) when the row has no
 * `foldId`.
 */
export const foldAt = <R extends { readonly foldId?: string }>(
  rows: ReadonlyArray<R>,
  cursor: number,
  collapsed: ReadonlySet<string>,
): ReadonlySet<string> => {
  const id = rows[clampCursor(rows.length, cursor)]?.foldId
  if (id === undefined) return collapsed
  const next = new Set(collapsed)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
