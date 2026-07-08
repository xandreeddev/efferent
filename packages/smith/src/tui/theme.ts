/**
 * The smith design system — the cli convention (palette → semantic tokens +
 * glyphs; no raw hex or glyph literal outside this file), trimmed to one
 * static theme (no live switcher; smith is a focused single view).
 */
const palette = {
  ink: "#d8d4c8",
  inkDim: "#807c72",
  inkBright: "#f2efe4",
  ember: "#e08f47",
  verdigris: "#5fb0a5",
  green: "#8fb573",
  red: "#e06c60",
  yellow: "#d9b04c",
  blue: "#7aa2f7",
  rule: "#3a3a40",
  gray: "#9a958a",
  cursorLine: "#2a2a30",
} as const

export const tokens = {
  text: {
    default: palette.ink,
    dim: palette.inkDim,
    bright: palette.inkBright,
    muted: palette.gray,
  },
  accent: { brand: palette.ember, input: palette.verdigris },
  marker: { select: palette.verdigris, cursor: palette.verdigris },
  cursorLine: palette.cursorLine,
  state: {
    ok: palette.green,
    error: palette.red,
    warn: palette.yellow,
    running: palette.blue,
    pending: palette.inkDim,
  },
  surface: { rule: palette.rule },
} as const

export const glyph = {
  brand: "▌",
  caret: "❯ ",
  pass: "✓",
  fail: "✗",
  skip: "◌",
  pending: "·",
  running: "●",
  pointer: ">",
  more: { above: "↑", below: "↓" },
  activeTag: "◀",
  cursorBlock: "█",
  rule: "─",
  bullet: "·",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
} as const
