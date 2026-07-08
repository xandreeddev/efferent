import { Match, Option } from "effect"
import {
  loginAdvance,
  loginAppend,
  loginBack,
  loginBackspace,
  loginMove,
} from "./presentation/loginFlow.js"
import type { LoginFlow } from "./presentation/loginFlow.js"
import {
  filterAppend,
  filterBackspace,
  moveSelect,
  selectedValue,
} from "./presentation/selectBox.js"
import { customRow } from "./presentation/modelCatalog.js"
import { openSelect } from "./presentation/selectBox.js"
import { advanceLogin, stopOAuthSession } from "./actions/login.js"
import { submitModel } from "./actions/model.js"
import { logout } from "./actions/login.js"
import type { Overlay, SmithTuiContext } from "./state/store.js"

/** The structural slice of OpenTUI's ParsedKey smith cares about. */
export interface Key {
  readonly name: string
  readonly ctrl?: boolean
  /** The literal characters typed (printables ride here). */
  readonly sequence?: string
  /** kitty protocol also delivers repeat/release — quit only on press. */
  readonly eventType?: string
}

/** Second Ctrl-C within this window quits; a lone press just warns —
 *  immune to a single stray byte at boot, and a deliberate exit stays
 *  two keystrokes away (the old TUI's proven rule). */
export const CTRL_C_WINDOW_MS = 1_500

/** The exit code a USER-initiated quit reports: a finished run's code, or
 *  0 — quitting an idle session is success, not an error (130 made every
 *  clean quit print bun's "error: script exited" line — live-caught). */
export const quitCode = (finished: number | undefined): number => finished ?? 0

/** The typed characters in a key event — printables only. Terminals without
 *  bracketed paste deliver pasted text as MULTI-char sequences; accept the
 *  whole chunk (control chars stripped) instead of dropping it. */
const printableChars = (key: Key): string =>
  key.ctrl === true || typeof key.sequence !== "string"
    ? ""
    : [...key.sequence].filter((ch) => ch >= " " && ch !== "\x7f").join("")

/** Re-open the model select with the free-text escape row appended when the
 *  filter looks like `provider:modelId`. */
const withCustomRow = (overlay: Overlay): Overlay => {
  if (overlay.kind !== "select" || overlay.purpose.tag !== "model") return overlay
  const extra = customRow(overlay.sel.filter)
  if (extra.length === 0) return overlay
  const already = overlay.sel.all.some((o) => o.desc === "not in the list")
  if (already) {
    // Rebuild: drop the stale custom row, append the fresh one.
    const base = overlay.sel.all.filter((o) => o.desc !== "not in the list")
    const rebuilt = openSelect(overlay.sel.title, [...base, ...extra])
    const refiltered = [...overlay.sel.filter].reduce((s, ch) => filterAppend(s, ch), rebuilt)
    return { ...overlay, sel: { ...refiltered, selected: overlay.sel.selected } }
  }
  return { ...overlay, sel: { ...overlay.sel, all: [...overlay.sel.all, ...extra] } }
}

const routeSelectKey = (ctx: SmithTuiContext, overlay: Overlay & { kind: "select" }, key: Key): void => {
  Match.value(key.name).pipe(
    Match.when("up", () => ctx.store.setOverlay({ ...overlay, sel: moveSelect(overlay.sel, "up") })),
    Match.when("down", () => ctx.store.setOverlay({ ...overlay, sel: moveSelect(overlay.sel, "down") })),
    Match.when("escape", () => ctx.store.closeOverlay()),
    Match.when("backspace", () =>
      ctx.store.setOverlay(withCustomRow({ ...overlay, sel: filterBackspace(overlay.sel) })),
    ),
    Match.when("return", () => {
      Option.match(selectedValue(overlay.sel), {
        onNone: () => ctx.store.setNotice("no match selected"),
        onSome: (value) => {
          if (overlay.purpose.tag === "model") {
            submitModel(ctx, overlay.purpose.role, value)
            return
          }
          // logout picker: the value IS the provider id.
          ctx.store.closeOverlay()
          logout(ctx, value)
        },
      })
    }),
    Match.orElse(() => {
      const chars = printableChars(key)
      if (chars.length > 0) {
        ctx.store.setOverlay(
          withCustomRow({ ...overlay, sel: filterAppend(overlay.sel, chars) }),
        )
      }
    }),
  )
}

const routeLoginKey = (ctx: SmithTuiContext, overlay: Overlay & { kind: "login" }, key: Key): void => {
  Match.value(key.name).pipe(
    Match.when("up", () => ctx.store.setOverlay({ ...overlay, flow: loginMove(overlay.flow, "up") })),
    Match.when("down", () =>
      ctx.store.setOverlay({ ...overlay, flow: loginMove(overlay.flow, "down") }),
    ),
    Match.when("escape", () => {
      if (overlay.flow.step === "oauth") stopOAuthSession(ctx)
      // Cancel the most specific thing FIRST: an active filter clears
      // before the step retreats.
      if (overlay.flow.step === "home" && overlay.flow.sel.filter.length > 0) {
        const cleared = [...overlay.flow.sel.filter].reduce<LoginFlow>(
          (f) => loginBackspace(f),
          overlay.flow,
        )
        ctx.store.setOverlay({ ...overlay, flow: cleared })
        return
      }
      Option.match(loginBack(overlay.flow), {
        onNone: () => ctx.store.closeOverlay(),
        onSome: (flow) => ctx.store.setOverlay({ ...overlay, flow }),
      })
    }),
    Match.when("backspace", () =>
      ctx.store.setOverlay({ ...overlay, flow: loginBackspace(overlay.flow) }),
    ),
    Match.when("return", () => advanceLogin(ctx, loginAdvance(overlay.flow))),
    Match.orElse(() => {
      const chars = printableChars(key)
      if (chars.length > 0) {
        ctx.store.setOverlay({ ...overlay, flow: loginAppend(overlay.flow, chars) })
      }
    }),
  )
}

/**
 * Global key routing, ONE precedence chain:
 *   1. Ctrl-C quits (always; finalizers restore the terminal).
 *   2. An open overlay owns every key (the composer is unmounted meanwhile).
 *   3. Esc cancels the most specific thing: a running forge, else the composer.
 */
export const dispatch = (ctx: SmithTuiContext, key: Key): void => {
  if (key.ctrl === true && key.name === "c") {
    if (key.eventType !== undefined && key.eventType !== "press") return
    const now = Date.now()
    if (now - ctx.store.ctrlCPendingAt() <= CTRL_C_WINDOW_MS) {
      ctx.exit(quitCode(ctx.store.exitCode()))
      return
    }
    ctx.store.setCtrlCPendingAt(now)
    ctx.store.setNotice("press Ctrl-C again to quit (or :quit)")
    return
  }
  const overlay = ctx.store.overlay()
  if (overlay.kind === "select") {
    routeSelectKey(ctx, overlay, key)
    return
  }
  if (overlay.kind === "login") {
    routeLoginKey(ctx, overlay, key)
    return
  }
  if (key.name === "escape") {
    const phase = ctx.store.floor().phase
    if (phase === "implementing" || phase === "gating" || phase === "boot") {
      ctx.store.setNotice("interrupting the run… (:quit to leave)")
      ctx.interrupt()
      return
    }
    ctx.store.clearComposer()
  }
}

/**
 * Bracketed pastes arrive as their OWN event (`usePaste`), never through the
 * key stream — an API key or a redirect URL pasted into an overlay prompt
 * lands here. No overlay open → the composer textarea owns the paste.
 */
export const dispatchPaste = (ctx: SmithTuiContext, text: string): void => {
  const clean = [...text].filter((ch) => ch >= " " && ch !== "\x7f").join("")
  if (clean.length === 0) return
  const overlay = ctx.store.overlay()
  if (overlay.kind === "select") {
    ctx.store.setOverlay(
      withCustomRow({ ...overlay, sel: filterAppend(overlay.sel, clean) }),
    )
    return
  }
  if (overlay.kind === "login") {
    ctx.store.setOverlay({ ...overlay, flow: loginAppend(overlay.flow, clean) })
  }
}

