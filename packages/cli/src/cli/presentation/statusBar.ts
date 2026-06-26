import { type ModelRole, parseModel } from "@xandreed/sdk-core"
import { glyph } from "./theme/index.js"

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
  /** Optional thinking/reasoning effort level shown next to the general model. */
  readonly effort?: string | undefined
  /** The three model roles (general · code · fast) with their resolved model ids,
   *  shown on the status bar's second row with the active one highlighted. */
  readonly roles?: ReadonlyArray<RoleEntry> | undefined
}

/** One model role's readout for the status bar's roles row. */
export interface RoleEntry {
  readonly role: ModelRole
  /** The resolved model id (no provider prefix, for width); follows general when unconfigured. */
  readonly modelId: string
  /** False when the role is unconfigured and therefore follows the general model. */
  readonly configured: boolean
}

/**
 * The status bar's **roles readout** — all three roles (general · code · fast)
 * with their resolved model ids, in display order. `code`/`fast` show the
 * general model id (dimmed via `configured: false`) when they aren't explicitly
 * set. Ids only (no provider prefix) for width; the full selection lives in
 * `:settings`. The bar marks the active role and dims the followers.
 */
export const rolesReadout = (settings: {
  readonly model: string
  readonly codeModel?: string | undefined
  readonly fastModel?: string | undefined
}): ReadonlyArray<RoleEntry> => [
  { role: "general", modelId: parseModel(settings.model).modelId, configured: true },
  {
    role: "code",
    modelId: parseModel(settings.codeModel ?? settings.model).modelId,
    configured: settings.codeModel !== undefined,
  },
  {
    role: "fast",
    modelId: parseModel(settings.fastModel ?? settings.model).modelId,
    configured: settings.fastModel !== undefined,
  },
]

/**
 * The status bar's **left zone** — one contextual hint, agy-style (the right
 * zone carries the model + gauge + storage + cwd). Precedence: a live transient
 * note (theme switched · working in agent …) wins; then a pending queue offers
 * `↑ to edit queued`; then a running turn / open overlay offers `esc to cancel`;
 * then a `:`/`/` line being composed also offers `esc to cancel` (Esc clears the
 * command line — so the hint must read true while you type a command, not the
 * idle `? for shortcuts`); otherwise the resting `? for shortcuts`.
 */
export const statusHint = (s: {
  readonly busy: boolean
  readonly overlayOpen: boolean
  readonly queuedCount: number
  /** The composer holds a `:command` / `/search` line (not an ordinary message). */
  readonly composing?: boolean | undefined
  readonly note?: string | undefined
}): string => {
  if (s.note !== undefined && s.note.length > 0) return s.note
  if (s.queuedCount > 0) return "↑ to edit queued"
  if (s.busy || s.overlayOpen) return "esc to cancel"
  if (s.composing === true) return "esc to cancel"
  return "? for shortcuts"
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
  if (total <= 0) return glyph.rule.repeat(width)
  const filled = Math.max(0, Math.min(width, Math.round((used / total) * width)))
  return glyph.gauge.full.repeat(filled) + glyph.gauge.empty.repeat(width - filled)
}

/** Context usage as a whole percent (`12`), or undefined when the window is unknown. */
export const contextPercent = (used: number, total: number): number | undefined =>
  total > 0 ? Math.min(999, Math.round((used / total) * 100)) : undefined

/**
 * How loudly the context gauge should speak. One scale for every surface:
 * under 70% it's bookkeeping; from 70% a fold is worth planning; from 90%
 * the next turns may degrade — `:handoff` now.
 */
export type GaugeSeverity = "ok" | "warn" | "critical"

export const gaugeSeverity = (used: number, total: number): GaugeSeverity => {
  const pct = contextPercent(used, total)
  if (pct === undefined) return "ok"
  return pct >= 90 ? "critical" : pct >= 70 ? "warn" : "ok"
}

/**
 * The share of the last turn's context that was served from the provider's
 * cache (`42` = 42%) — the caching story in one number. Undefined until a
 * turn has reported real usage.
 */
export const cachePercent = (cacheRead: number, input: number): number | undefined =>
  input > 0 ? Math.round((Math.min(cacheRead, input) / input) * 100) : undefined

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
