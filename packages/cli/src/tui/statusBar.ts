import { ansi, padRight, truncate } from "./terminal.js"

export type EditorModeLabel = "INS" | "NOR" | "VIS"

export interface StatusState {
  readonly modelId: string
  readonly contextWindow: number
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cwd: string
  /** Optional ephemeral note, e.g. "thinking…", "waiting for tool…". */
  readonly note?: string | undefined
  /** Modal mode label (NORMAL/INSERT/VISUAL), shown leftmost. */
  readonly mode?: EditorModeLabel
  /** Focused pane label (chat/side/input), shown next to the mode. */
  readonly pane?: string
}

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${n}`
}

const gauge = (used: number, total: number, width: number): string => {
  if (total <= 0) return "─".repeat(width)
  const filled = Math.max(0, Math.min(width, Math.round((used / total) * width)))
  return "▓".repeat(filled) + ansi.dim + "░".repeat(width - filled) + ansi.reset
}

const homeDir = (() => {
  try {
    return process.env["HOME"] ?? ""
  } catch {
    return ""
  }
})()

const prettyCwd = (cwd: string): string =>
  homeDir !== "" && cwd.startsWith(homeDir) ? `~${cwd.slice(homeDir.length)}` : cwd

const renderMode = (
  mode: EditorModeLabel | undefined,
  pane: string | undefined,
): string => {
  if (mode === undefined) return ""
  const block =
    mode === "NOR"
      ? `${ansi.bold}${ansi.bgBrightCyan}${ansi.fgBlack} NORMAL ${ansi.reset}`
      : mode === "VIS"
        ? `${ansi.bold}${ansi.bgBrightYellow}${ansi.fgBlack} VISUAL ${ansi.reset}`
        : `${ansi.bold}${ansi.bgBrightGreen}${ansi.fgBlack} INSERT ${ansi.reset}`
  const paneTag = pane !== undefined ? ` ${ansi.dim}${pane}${ansi.reset}` : ""
  return `${block}${paneTag}  `
}

export const renderStatusBar = (state: StatusState, cols: number): string => {
  const mode = renderMode(state.mode, state.pane)
  const left = `${ansi.bold}${ansi.fgBrightCyan}${state.modelId}${ansi.reset}`
  const used = state.inputTokens
  const cached = state.cacheReadTokens
  const tokensText =
    cached > 0
      ? `${formatTokens(used)} (${formatTokens(cached)} cached) / ${formatTokens(
          state.contextWindow,
        )}`
      : `${formatTokens(used)} / ${formatTokens(state.contextWindow)}`
  const middle = `${gauge(used, state.contextWindow, 8)} ${ansi.fgGray}${tokensText}${ansi.reset}`
  const right = `${ansi.fgGray}${prettyCwd(state.cwd)}${ansi.reset}`
  const note =
    state.note !== undefined
      ? `  ${ansi.fgYellow}· ${state.note}${ansi.reset}`
      : ""

  const composed = `${mode}${left}  ${middle}${note}  ${right}`
  const truncated = truncate(composed, cols)
  return `${ansi.bgDarkGray}${padRight(truncated, cols)}${ansi.reset}`
}
