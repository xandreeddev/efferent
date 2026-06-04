/**
 * Status-bar **display config** — model + workspace chrome only. Token/usage
 * numbers (input/cacheRead/contextWindow) deliberately live in `SessionStats`
 * (`sidePane.ts`), the single source the bar reads via `store.stats()`; keeping
 * them out of here is what stops the two from drifting (the old triple-write).
 * The transient busy `note` is its own session signal, not part of this shape.
 */
export interface StatusState {
  readonly modelId: string
  readonly cwd: string
  /** Active conversation store, e.g. "sqlite" or "pg". Shown before cwd. */
  readonly storage: string
  /** Optional thinking/reasoning effort level shown next to the model. */
  readonly effort?: string | undefined
}

export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${n}`
}

/**
 * A plain `▓░` progress bar of `width` cells, `used/total` filled. No ANSI — the
 * OpenTUI status bar and Activity dashboard colour it via `fg` props. Shared by
 * both so the two gauges can't drift.
 */
export const gaugeBar = (used: number, total: number, width: number): string => {
  if (total <= 0) return "─".repeat(width)
  const filled = Math.max(0, Math.min(width, Math.round((used / total) * width)))
  return "▓".repeat(filled) + "░".repeat(width - filled)
}

const homeDir = (() => {
  try {
    return process.env["HOME"] ?? ""
  } catch {
    return ""
  }
})()

/** `~`-abbreviated cwd for the status bar. */
export const prettyCwd = (cwd: string): string =>
  homeDir !== "" && cwd.startsWith(homeDir) ? `~${cwd.slice(homeDir.length)}` : cwd
