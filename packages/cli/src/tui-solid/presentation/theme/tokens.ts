import { type Palette } from "./palette.js"

/** The three focusable panes; each owns an accent colour. */
export type PaneKind = "conversation" | "side" | "input"

/**
 * Code/markdown scope colours — the single source for both `view/syntax.ts`'s
 * `SyntaxStyle` (fenced code + diff hunks) and the native `<markdown>` prose
 * scopes (`markup.*`). Roles, not raw hexes, so a palette swap re-themes code.
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

/**
 * Tier 2: **semantic tokens** — every visual role the views paint. This shape is
 * the *stable interface*: token names never change. A **theme** is one complete
 * set of values for these same tokens ({@link ./themes.ts}); swapping themes
 * swaps the values, not the structure. Views and view-primitives reference these
 * (never a palette entry or a raw hex), so intent is explicit and theme-portable.
 */
export interface Tokens {
  /** Per-pane focus accents — the focused box's border + title brighten to these. */
  readonly accent: Record<PaneKind, string>
  readonly border: { readonly unfocused: string }
  readonly text: {
    readonly default: string
    readonly user: string
    readonly assistant: string
    readonly heading: string
    readonly muted: string
    readonly dim: string
  }
  /** Run states for tool pills / the execution tree (running · ok · error). */
  readonly state: { readonly running: string; readonly ok: string; readonly error: string }
  /** Context-viewer markers: the ◉ pick, the ⚑ handoff, the ● loaded dot, the █ cursor. */
  readonly marker: {
    readonly select: string
    readonly cursor: string
    readonly handoff: string
    readonly loaded: string
  }
  /** Conversation `/`-search highlight buckets (current match · other match · header). */
  readonly match: { readonly current: string; readonly other: string; readonly header: string }
  /** Modal overlay surface + its border. */
  readonly overlay: { readonly bg: string; readonly border: string }
  /** Status-bar surface. */
  readonly status: { readonly bg: string }
  /** Focused-row background tint (context viewer / select list / settings). */
  readonly cursorLine: string
  readonly info: string
  readonly error: string
  readonly syntax: SyntaxTokens
}

/**
 * Build a complete token set from a small palette — a DRY authoring helper for a
 * theme whose values are derived from primitives (the built-in `one-dark` theme
 * uses this). A theme is free to hand-author its `Tokens` instead; the contract
 * is the token set, not the palette.
 */
export const makeTokens = (p: Palette): Tokens => ({
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
  match: { current: p.green, other: p.cyan, header: p.blue },
  overlay: { bg: p.bgOverlay, border: p.magenta },
  status: { bg: p.bgStatus },
  cursorLine: p.cursorLine,
  info: p.gray,
  error: p.red,
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
