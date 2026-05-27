/**
 * Minimal ANSI / raw-mode primitives. No dependency on a TUI library —
 * Bun + node:tty + a handful of escape sequences is enough for the
 * three-region (status / scrollback / input) layout we render.
 */

export const ESC = "\x1b"
export const CSI = `${ESC}[`

export const ansi = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,
  inverse: `${CSI}7m`,

  fgBlack: `${CSI}30m`,
  fgRed: `${CSI}31m`,
  fgGreen: `${CSI}32m`,
  fgYellow: `${CSI}33m`,
  fgBlue: `${CSI}34m`,
  fgMagenta: `${CSI}35m`,
  fgCyan: `${CSI}36m`,
  fgWhite: `${CSI}37m`,
  fgGray: `${CSI}90m`,
  fgBrightRed: `${CSI}91m`,
  fgBrightGreen: `${CSI}92m`,
  fgBrightYellow: `${CSI}93m`,
  fgBrightBlue: `${CSI}94m`,
  fgBrightMagenta: `${CSI}95m`,
  fgBrightCyan: `${CSI}96m`,

  bgBlue: `${CSI}44m`,
  bgGray: `${CSI}100m`,
  bgDarkGray: `${CSI}48;5;236m`,
}

export const enterAltBuffer = `${CSI}?1049h${CSI}?25l`
export const exitAltBuffer = `${CSI}?1049l${CSI}?25h`
export const enableBracketedPaste = `${CSI}?2004h`
export const disableBracketedPaste = `${CSI}?2004l`
export const clearScreen = `${CSI}2J`
export const home = `${CSI}H`
export const hideCursor = `${CSI}?25l`
export const showCursor = `${CSI}?25h`

export const moveTo = (row: number, col: number): string =>
  `${CSI}${row};${col}H`

export const clearLine = `${CSI}2K`
export const clearToEol = `${CSI}0K`

/** Strip ANSI escapes from a string so visible-length math is accurate. */
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "")

/** Visible width of a string, accounting for ANSI escapes. */
export const visibleLength = (s: string): number => stripAnsi(s).length

export const padRight = (s: string, width: number): string => {
  const v = visibleLength(s)
  return v >= width ? s : s + " ".repeat(width - v)
}

export const padLeft = (s: string, width: number): string => {
  const v = visibleLength(s)
  return v >= width ? s : " ".repeat(width - v) + s
}

/**
 * Truncate a string to `width` visible columns. Naïve: assumes 1 col
 * per non-ANSI char. Good enough for ASCII paths and English markdown.
 */
export const truncate = (s: string, width: number): string => {
  if (visibleLength(s) <= width) return s
  const stripped = stripAnsi(s).slice(0, width - 1)
  return `${stripped}…`
}

export interface TermSize {
  readonly rows: number
  readonly cols: number
}

export const getTermSize = (): TermSize => ({
  rows: (process.stdout as { rows?: number }).rows ?? 24,
  cols: (process.stdout as { columns?: number }).columns ?? 80,
})

export const setupRawMode = (): (() => void) => {
  const stdin = process.stdin as NodeJS.ReadStream & {
    setRawMode?: (raw: boolean) => unknown
  }
  const wasRaw = typeof stdin.isRaw === "boolean" ? stdin.isRaw : false
  if (typeof stdin.setRawMode === "function") {
    stdin.setRawMode(true)
  }
  stdin.resume()
  const restore = () => {
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(wasRaw)
    }
  }
  return restore
}

export const write = (s: string): void => {
  process.stdout.write(s)
}

export const writeErr = (s: string): void => {
  process.stderr.write(s)
}

export const enterTui = (): void => {
  write(enterAltBuffer + enableBracketedPaste + clearScreen + home)
}

export const exitTui = (): void => {
  write(disableBracketedPaste + exitAltBuffer + showCursor + ansi.reset)
}
