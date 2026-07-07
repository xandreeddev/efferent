import type { Palette, WebSurfaces } from "./palette.js"

/**
 * Semantic web tokens — the TUI's `Tokens` shape mirrored field-for-field
 * (minus the terminal-only `bgNone`), plus the web-only `surface` group.
 * Views never paint a palette entry or a raw hex; they paint `var(--tok-*)`
 * custom properties generated from this shape (see ./css.ts).
 */
export interface SyntaxTokens {
  readonly heading: string
  readonly raw: string
  readonly quote: string
  readonly list: string
  readonly link: string
  readonly linkUrl: string
  readonly keyword: string
  readonly string: string
  readonly escape: string
  readonly number: string
  readonly function: string
  readonly type: string
  readonly comment: string
  readonly variable: string
  readonly param: string
  readonly punctuation: string
}

export interface WebTokens {
  readonly accent: {
    readonly conversation: string
    readonly side: string
    readonly input: string
  }
  readonly border: { readonly unfocused: string }
  readonly text: {
    readonly default: string
    readonly user: string
    readonly assistant: string
    readonly heading: string
    readonly muted: string
    readonly dim: string
  }
  readonly state: { readonly running: string; readonly ok: string; readonly error: string }
  readonly marker: {
    readonly select: string
    readonly cursor: string
    readonly handoff: string
    readonly loaded: string
  }
  readonly match: {
    readonly current: string
    readonly other: string
    readonly line: string
    readonly currentLine: string
    readonly word: { readonly bg: string; readonly fg: string }
    readonly wordCurrent: { readonly bg: string; readonly fg: string }
  }
  readonly cursorLine: string
  readonly info: string
  readonly error: string
  readonly surface: WebSurfaces
  readonly syntax: SyntaxTokens
}

/** Mirror of the TUI's `makeTokens` derivation, extended with surfaces. */
export const makeWebTokens = (p: Palette, surface: WebSurfaces): WebTokens => ({
  accent: { conversation: p.cyan, side: p.magenta, input: p.green },
  border: { unfocused: p.dim },
  text: {
    default: p.text,
    user: p.textUser,
    assistant: p.cyan,
    heading: p.blue,
    muted: p.gray,
    dim: p.dim,
  },
  state: { running: p.yellow, ok: p.greenMuted, error: p.red },
  marker: { select: p.green, cursor: p.green, handoff: p.magenta, loaded: p.greenMuted },
  match: {
    current: p.green,
    other: p.cyan,
    line: p.matchLine,
    currentLine: p.matchLineCurrent,
    word: { bg: p.cyan, fg: p.bgStatus },
    wordCurrent: { bg: p.green, fg: p.bgStatus },
  },
  cursorLine: p.cursorLine,
  info: p.gray,
  error: p.red,
  surface,
  syntax: {
    heading: p.blue,
    raw: p.greenMuted,
    quote: p.gray,
    list: p.gray,
    link: p.cyan,
    linkUrl: p.dim,
    keyword: p.purple,
    string: p.greenMuted,
    escape: p.teal,
    number: p.orange,
    function: p.blue,
    type: p.yellow,
    comment: p.comment,
    variable: p.red,
    param: p.orange,
    punctuation: p.punctuation,
  },
})
