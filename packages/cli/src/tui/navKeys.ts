import type { Key } from "./keys.js"
import { moveFocus, type FocusPane, type UiMode } from "./uiMode.js"

/**
 * Pure key-routing for the modal, multi-pane TUI. `decideKey` takes the
 * current navigation context + a key and returns an *intent* describing what
 * should happen — no side effects, no Effects, no Scrollback mutation. The
 * driver (`tui.ts`) executes the intent. Keeping this pure makes the whole
 * bind surface unit-testable (see the probes), which is where the earlier
 * "panes never swap / search is broken" bugs lived.
 *
 * Design decisions baked in here:
 *  - **Ctrl-h/j/k/l swaps focus in *any* mode** (including INSERT), but only
 *    when there's actually a pane that way — otherwise the key falls through
 *    to the editor (so Ctrl-J = newline / Ctrl-H = backspace still work in the
 *    input, which have no pane below/left).
 *  - **Entering the input pane → INSERT** (type immediately); entering a
 *    read-only pane → NORMAL. This is what makes Ctrl-K↔Ctrl-J feel right.
 *  - `/` opens search and `:`-commands stay in the palette; Esc in NORMAL
 *    clears a lingering search highlight before anything else.
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

export interface NavCtx {
  readonly focus: FocusPane
  readonly mode: UiMode
  /** A `/` query is currently being typed. */
  readonly searching: boolean
  /** A query is set (highlights shown; n/N navigable). */
  readonly searchActive: boolean
  /** The first `g` of a `gg` motion has been seen. */
  readonly navPending: boolean
  /** Whether the side pane is on screen (wide enough). */
  readonly sideVisible: boolean
}

export type NavIntent =
  /** Hand the key to the input editor (typing / vi motions). */
  | { readonly kind: "input" }
  /** Swallow; just repaint. */
  | { readonly kind: "none" }
  | { readonly kind: "focus"; readonly to: FocusPane; readonly mode: UiMode }
  | { readonly kind: "scroll"; readonly op: ScrollOp }
  | { readonly kind: "visualMove"; readonly op: ScrollOp }
  | { readonly kind: "gPending" }
  | { readonly kind: "enterVisual" }
  | { readonly kind: "exitVisual" }
  | { readonly kind: "yank" }
  | { readonly kind: "openSearch" }
  | { readonly kind: "searchChar"; readonly char: string }
  | { readonly kind: "searchBack" }
  | { readonly kind: "searchJump" }
  | { readonly kind: "searchCancel" }
  | { readonly kind: "searchSwallow" }
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
  // 1. Typing a `/` query captures everything until Enter/Esc.
  if (ctx.searching) {
    if (key.type === "escape") return { kind: "searchCancel" }
    if (key.type === "enter") return { kind: "searchJump" }
    if (key.type === "char") return { kind: "searchChar", char: key.char }
    if (key.type === "backspace") return { kind: "searchBack" }
    return { kind: "searchSwallow" }
  }

  // 2. Ctrl-h/j/k/l: focus a neighbouring pane (any mode). Only when there's
  //    a pane that way — else fall through so the editor keeps Ctrl-J/Ctrl-H.
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
      if (key.type === "char" && key.char === "/") return { kind: "openSearch" }
      if (
        key.type === "char" &&
        (key.char === "n" || key.char === "N") &&
        ctx.searchActive
      ) {
        return { kind: "match", dir: key.char === "n" ? "next" : "prev" }
      }
      if (key.type === "escape" && ctx.searchActive) return { kind: "clearSearch" }
    }
    return { kind: "input" }
  }

  // 5. Conversation pane.
  if (ctx.focus === "conversation") {
    if (ctx.mode === "visual") return decideVisual(ctx, key)
    return decideConversationNormal(ctx, key)
  }

  // 6. Side pane (minimal): drop back to the input, or open search.
  if (ctx.focus === "side") {
    if (key.type === "char" && key.char === "i") {
      return { kind: "focus", to: "input", mode: "insert" }
    }
    if (key.type === "char" && key.char === "/") return { kind: "openSearch" }
    if (key.type === "escape") {
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
      case "n":
        return ctx.searchActive ? { kind: "match", dir: "next" } : { kind: "none" }
      case "N":
        return ctx.searchActive ? { kind: "match", dir: "prev" } : { kind: "none" }
      case "v":
        return { kind: "enterVisual" }
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
    return ctx.searchActive
      ? { kind: "clearSearch" }
      : { kind: "focus", to: "input", mode: "normal" }
  }
  return { kind: "none" }
}

const decideVisual = (ctx: NavCtx, key: Key): NavIntent => {
  if (ctx.navPending && key.type === "char" && key.char === "g") {
    return { kind: "visualMove", op: "top" }
  }
  if (key.type === "char") {
    switch (key.char) {
      case "y":
        return { kind: "yank" }
      case "v":
        return { kind: "exitVisual" }
      case "j":
        return { kind: "visualMove", op: "lineDown" }
      case "k":
        return { kind: "visualMove", op: "lineUp" }
      case "g":
        return { kind: "gPending" }
      case "G":
        return { kind: "visualMove", op: "bottom" }
      default:
        return { kind: "none" }
    }
  }
  if (key.type === "escape") return { kind: "exitVisual" }
  if (key.type === "arrow") {
    if (key.dir === "down") return { kind: "visualMove", op: "lineDown" }
    if (key.dir === "up") return { kind: "visualMove", op: "lineUp" }
  }
  return { kind: "none" }
}
