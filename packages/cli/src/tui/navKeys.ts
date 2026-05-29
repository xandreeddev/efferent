import type { Key } from "./keys.js"
import { moveFocus, type FocusPane, type UiMode } from "./uiMode.js"

/**
 * Pure key-routing for the modal, multi-pane TUI. `decideKey` takes the
 * current navigation context + a key and returns an *intent* describing what
 * should happen — no side effects, no Effects, no Scrollback mutation. The
 * driver (`tui.ts`) executes the intent. Keeping this pure makes the whole
 * bind surface unit-testable (see `navKeys.test.ts`).
 *
 * The bottom input row is a vim-style command line with an `entry` mode:
 *  - `message` → normal text; prompt `❯`.
 *  - `command` → a `:` command; prompt `:`.
 *  - `search`  → a `/` query; prompt `/`.
 * `:` / `/` open command/search from NORMAL, or from INSERT when the input is
 * empty (so you can still type them literally mid-message). While an entry is
 * active, keystrokes edit its body; Enter runs/jumps, Esc cancels.
 *
 * Focus: Ctrl-h/j/k/l swaps panes in any mode, but only when a pane exists that
 * way — so Ctrl-J/Ctrl-H stay newline/backspace in the input. Entering the
 * input pane → INSERT; entering a read-only pane → NORMAL.
 */

export type ScrollOp =
  | "lineUp"
  | "lineDown"
  | "halfUp"
  | "halfDown"
  | "pageUp"
  | "pageDown"
  | "top"
  | "bottom"
  | "msgUp"
  | "msgDown"

export type EntryMode = "message" | "command" | "search"

export interface NavCtx {
  readonly focus: FocusPane
  readonly mode: UiMode
  /** Command-line entry mode of the bottom input row. */
  readonly entry: EntryMode
  /** Whether the input buffer is currently empty (gates `:`/`/` in INSERT). */
  readonly inputEmpty: boolean
  /** A query is set (highlights shown; n/N navigable). */
  readonly searchActive: boolean
  /** The first `g` of a `gg` motion has been seen. */
  readonly navPending: boolean
  /** Whether the side pane is on screen (wide enough). */
  readonly sideVisible: boolean
  /** Whether the focused pane is maximized (zoom). Esc exits zoom first. */
  readonly zoomed: boolean
}

export type NavIntent =
  /** Hand the key to the input editor (message typing / vi motions). */
  | { readonly kind: "input" }
  /** Swallow; just repaint. */
  | { readonly kind: "none" }
  | { readonly kind: "focus"; readonly to: FocusPane; readonly mode: UiMode }
  /**
   * Move the conversation cursor (viewport follows). In VISUAL the same op
   * extends the selection — the scrollback's cursor *is* the selection cursor.
   */
  | { readonly kind: "scroll"; readonly op: ScrollOp }
  | { readonly kind: "gPending" }
  | { readonly kind: "enterVisual" }
  | { readonly kind: "exitVisual" }
  | { readonly kind: "yank" }
  /** Toggle maximize on the focused read-only pane. */
  | { readonly kind: "toggleZoom" }
  | { readonly kind: "openCommand" }
  | { readonly kind: "openSearch" }
  /** Edit the active command/search body (driver runs the input editor). */
  | { readonly kind: "entryEdit" }
  /** Run the command / jump to the search match. */
  | { readonly kind: "entrySubmit" }
  /** Abandon the command/search line, back to a message. */
  | { readonly kind: "entryCancel" }
  | { readonly kind: "match"; readonly dir: "next" | "prev" }
  | { readonly kind: "clearSearch" }

const ctrlDir = (
  char: string,
): "left" | "right" | "up" | "down" | undefined => {
  switch (char) {
    case "h":
      return "left"
    case "l":
      return "right"
    case "k":
      return "up"
    case "j":
      return "down"
    default:
      return undefined
  }
}

export const decideKey = (ctx: NavCtx, key: Key): NavIntent => {
  // 1. A `:` command or `/` search is being typed — body editing captures keys.
  if (ctx.entry !== "message") {
    if (key.type === "escape") return { kind: "entryCancel" }
    if (key.type === "enter") return { kind: "entrySubmit" }
    return { kind: "entryEdit" }
  }

  // 2. Ctrl-h/j/k/l: focus a neighbouring pane (any mode). Only when there's a
  //    pane that way — else fall through so the editor keeps Ctrl-J/Ctrl-H.
  if (key.type === "ctrl") {
    const dir = ctrlDir(key.char)
    if (dir !== undefined) {
      const to = moveFocus(ctx.focus, dir, ctx.sideVisible)
      if (to !== ctx.focus) {
        return { kind: "focus", to, mode: to === "input" ? "insert" : "normal" }
      }
    }
  }

  // 3. PgUp/PgDn always page the conversation, whatever has focus.
  if (key.type === "pageUp") return { kind: "scroll", op: "pageUp" }
  if (key.type === "pageDown") return { kind: "scroll", op: "pageDown" }

  // 4. Input pane.
  if (ctx.focus === "input") {
    if (ctx.mode === "normal") {
      if (key.type === "char" && key.char === ":") return { kind: "openCommand" }
      if (key.type === "char" && key.char === "/") return { kind: "openSearch" }
      if (
        key.type === "char" &&
        (key.char === "n" || key.char === "N") &&
        ctx.searchActive
      ) {
        return { kind: "match", dir: key.char === "n" ? "next" : "prev" }
      }
      if (key.type === "escape" && ctx.searchActive) return { kind: "clearSearch" }
      return { kind: "input" }
    }
    // INSERT: `:`/`/` open a command/search only on an empty buffer, so they
    // stay literal mid-message.
    if (ctx.inputEmpty && key.type === "char" && key.char === ":") {
      return { kind: "openCommand" }
    }
    if (ctx.inputEmpty && key.type === "char" && key.char === "/") {
      return { kind: "openSearch" }
    }
    return { kind: "input" }
  }

  // 5. Conversation pane.
  if (ctx.focus === "conversation") {
    if (ctx.mode === "visual") return decideVisual(ctx, key)
    return decideConversationNormal(ctx, key)
  }

  // 6. Side pane (minimal): zoom, command/search, drop back to the input.
  if (ctx.focus === "side") {
    if (key.type === "char" && key.char === "i") {
      return { kind: "focus", to: "input", mode: "insert" }
    }
    if (key.type === "char" && key.char === "z") return { kind: "toggleZoom" }
    if (key.type === "char" && key.char === ":") return { kind: "openCommand" }
    if (key.type === "char" && key.char === "/") return { kind: "openSearch" }
    if (key.type === "escape") {
      if (ctx.zoomed) return { kind: "toggleZoom" }
      return { kind: "focus", to: "input", mode: "normal" }
    }
  }
  return { kind: "none" }
}

const decideConversationNormal = (ctx: NavCtx, key: Key): NavIntent => {
  // `gg` — second `g` jumps to the top.
  if (ctx.navPending && key.type === "char" && key.char === "g") {
    return { kind: "scroll", op: "top" }
  }
  if (key.type === "char") {
    switch (key.char) {
      case "j":
        return { kind: "scroll", op: "lineDown" }
      case "k":
        return { kind: "scroll", op: "lineUp" }
      case "g":
        return { kind: "gPending" }
      case "G":
        return { kind: "scroll", op: "bottom" }
      case "{":
      case "[":
        return { kind: "scroll", op: "msgUp" }
      case "}":
      case "]":
        return { kind: "scroll", op: "msgDown" }
      case "/":
        return { kind: "openSearch" }
      case ":":
        return { kind: "openCommand" }
      case "n":
        return ctx.searchActive ? { kind: "match", dir: "next" } : { kind: "none" }
      case "N":
        return ctx.searchActive ? { kind: "match", dir: "prev" } : { kind: "none" }
      case "v":
        return { kind: "enterVisual" }
      case "z":
        return { kind: "toggleZoom" }
      case "i":
        return { kind: "focus", to: "input", mode: "insert" }
      default:
        return { kind: "none" }
    }
  }
  if (key.type === "ctrl") {
    if (key.char === "d") return { kind: "scroll", op: "halfDown" }
    if (key.char === "u") return { kind: "scroll", op: "halfUp" }
    return { kind: "none" }
  }
  if (key.type === "arrow") {
    if (key.dir === "down") return { kind: "scroll", op: "lineDown" }
    if (key.dir === "up") return { kind: "scroll", op: "lineUp" }
    return { kind: "none" }
  }
  if (key.type === "escape") {
    // Esc unwinds one layer at a time: zoom → search highlight → drop to input.
    if (ctx.zoomed) return { kind: "toggleZoom" }
    return ctx.searchActive
      ? { kind: "clearSearch" }
      : { kind: "focus", to: "input", mode: "normal" }
  }
  return { kind: "none" }
}

const decideVisual = (ctx: NavCtx, key: Key): NavIntent => {
  // Selection extends via the same cursor motions as NORMAL (the scrollback's
  // cursor is the selection cursor) — so VISUAL emits plain `scroll` ops.
  if (ctx.navPending && key.type === "char" && key.char === "g") {
    return { kind: "scroll", op: "top" }
  }
  if (key.type === "char") {
    switch (key.char) {
      case "y":
        return { kind: "yank" }
      case "v":
        return { kind: "exitVisual" }
      case "j":
        return { kind: "scroll", op: "lineDown" }
      case "k":
        return { kind: "scroll", op: "lineUp" }
      case "g":
        return { kind: "gPending" }
      case "G":
        return { kind: "scroll", op: "bottom" }
      default:
        return { kind: "none" }
    }
  }
  if (key.type === "ctrl") {
    if (key.char === "d") return { kind: "scroll", op: "halfDown" }
    if (key.char === "u") return { kind: "scroll", op: "halfUp" }
    return { kind: "none" }
  }
  if (key.type === "escape") return { kind: "exitVisual" }
  if (key.type === "arrow") {
    if (key.dir === "down") return { kind: "scroll", op: "lineDown" }
    if (key.dir === "up") return { kind: "scroll", op: "lineUp" }
  }
  return { kind: "none" }
}
