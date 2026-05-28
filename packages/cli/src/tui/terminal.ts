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
  strikethrough: `${CSI}9m`,

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
  // Subtle 256-color tints for code blocks and diff add/remove lines.
  bgCode: `${CSI}48;5;235m`,
  bgDiffAdd: `${CSI}48;5;22m`,
  bgDiffDel: `${CSI}48;5;52m`,
}

export const enterAltBuffer = `${CSI}?1049h${CSI}?25l`
export const exitAltBuffer = `${CSI}?1049l${CSI}?25h`
export const enableBracketedPaste = `${CSI}?2004h`
export const disableBracketedPaste = `${CSI}?2004l`
export const clearScreen = `${CSI}2J`
export const home = `${CSI}H`
export const hideCursor = `${CSI}?25l`
export const showCursor = `${CSI}?25h`

/**
 * DEC private mode 2026 — synchronized output. Wrapping a full frame
 * write between these tells supporting terminals to buffer the update
 * and paint it atomically (no half-drawn frames / tearing). Terminals
 * that don't support it ignore the unknown private mode — harmless.
 */
export const beginSync = `${CSI}?2026h`
export const endSync = `${CSI}?2026l`

/** Braille spinner frames, shared by the status bar and the agent tree. */
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const

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

/** Hard-break a (visible, escape-free) string into `width`-column chunks. */
const hardWrap = (visible: string, width: number): string[] => {
  const out: string[] = []
  for (let i = 0; i < visible.length; i += width) {
    out.push(visible.slice(i, i + width))
  }
  return out.length > 0 ? out : [""]
}

/**
 * Word-wrap a (possibly ANSI-styled) string to `width` visible columns,
 * measuring with `visibleLength` so escapes don't count. Splits on spaces;
 * a single token longer than `width` (e.g. a URL) is hard-broken — escapes
 * are stripped from that token so the break never lands mid-sequence.
 * Embedded `\n` start new paragraphs. No prefix is added — callers prepend
 * their own marker/indent (see the user-block and list/quote renderers).
 */
export const wrapAnsi = (s: string, width: number): string[] => {
  if (width <= 0) return s.split("\n")
  const out: string[] = []
  for (const para of s.split("\n")) {
    if (para.length === 0) {
      out.push("")
      continue
    }
    let line = ""
    for (const word of para.split(" ")) {
      const wlen = visibleLength(word)
      if (wlen > width) {
        if (line.length > 0) {
          out.push(line)
          line = ""
        }
        const chunks = hardWrap(stripAnsi(word), width)
        for (let k = 0; k < chunks.length - 1; k++) out.push(chunks[k]!)
        line = chunks[chunks.length - 1] ?? ""
        continue
      }
      if (line.length === 0) {
        line = word
      } else if (visibleLength(line) + 1 + wlen > width) {
        out.push(line)
        line = word
      } else {
        line += " " + word
      }
    }
    if (line.length > 0) out.push(line)
  }
  return out
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
    // `resume()` above ref'd stdin into the event loop; without pausing,
    // the process stays alive after the TUI exits (needing a second
    // Ctrl-C). Pause to release the ref so the runtime can exit cleanly.
    stdin.pause()
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
