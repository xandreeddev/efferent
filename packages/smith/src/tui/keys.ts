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
import { completeCommand } from "./presentation/palette.js"
import { recallStep } from "./presentation/history.js"
import { cycleSearch, searchNotice } from "./presentation/search.js"
import { initialVi, viNormalStep } from "./presentation/vi.js"
import type { ViEdit } from "./presentation/vi.js"
import { customRow } from "./presentation/modelCatalog.js"
import { openSelect } from "./presentation/selectBox.js"
import { advanceLogin, stopOAuthSession } from "./actions/login.js"
import { openModelPicker, submitModel } from "./actions/model.js"
import {
  openFallbackPicker,
  openNumberPicker,
  submitSetting,
  toggleSandbox,
  toggleViMode,
} from "./actions/settings.js"
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
          if (overlay.purpose.tag === "resume") {
            ctx.store.closeOverlay()
            Option.match(value, {
              onNone: () => ctx.store.setNotice("nothing selected"),
              onSome: (id) => ctx.resume?.(id),
            })
            return
          }
          if (overlay.purpose.tag === "settings") {
            // A settings row EDITS that setting through the design system's
            // existing overlays: roles → the model picker, fallback → its
            // picker, sandbox → an in-place toggle, numerics → presets.
            ctx.store.closeOverlay()
            Option.match(value, {
              onNone: () => ctx.store.setNotice("nothing selected"),
              onSome: (row) => {
                if (row === "fallbackModel") return openFallbackPicker(ctx)
                if (row === "sandbox") return toggleSandbox(ctx)
                if (row === "viMode") return toggleViMode(ctx)
                if (row === "maxAttempts" || row === "budgetMillis") {
                  return openNumberPicker(ctx, row)
                }
                return openModelPicker(ctx, row === "code" || row === "fast" ? row : "general")
              },
            })
            return
          }
          if (overlay.purpose.tag === "fallback-model") {
            submitSetting(ctx, "fallbackModel", value)
            return
          }
          if (overlay.purpose.tag === "setting-number") {
            const key = overlay.purpose.key
            submitSetting(
              ctx,
              key,
              value,
              Option.getOrUndefined(
                Option.map(value, (raw) =>
                  key === "budgetMillis" ? `${Math.round(Number(raw) / 60_000)}m` : raw,
                ),
              ),
            )
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
  // --- vi mode (enabled via :settings / config "viMode") ---
  // Insert = the composer exactly as without vi; Esc parks the textarea
  // (blur — a parked textarea can never swallow motion keys) and enters
  // normal. In NORMAL, Esc falls THROUGH to the session's one Esc rule.
  if (ctx.store.viEnabled() && key.ctrl !== true) {
    const vi = ctx.store.vi()
    if (vi.mode === "insert" && key.name === "escape") {
      ctx.store.setVi({ mode: "normal", pending: Option.none() })
      ctx.store.blurComposer()
      return
    }
    if (vi.mode === "normal" && key.name !== "escape") {
      if (key.name === "return") {
        // Enter in normal SUBMITS the line (the composer's own binding is
        // parked with the blur) and re-enters insert for the next prompt.
        ctx.store.setVi(initialVi)
        ctx.store.focusComposer()
        ctx.store.submitComposer()
        return
      }
      const typed = printableChars(key)
      const edit = typed.length === 1
        ? viNormalStep(vi, typed, ctx.store.composerText(), ctx.store.composerCursor())
        : Option.none<ViEdit>()
      Option.match(edit, {
        onNone: () => {},
        onSome: (applied) => {
          ctx.store.setVi(applied.state)
          if (applied.text !== undefined) ctx.store.setComposer(applied.text)
          if (applied.cursor !== undefined) ctx.store.setComposerCursor(applied.cursor)
          if (applied.recall !== undefined) {
            Option.match(
              recallStep(ctx.store.history(), applied.recall, ctx.store.composerText()),
              {
                onNone: () => {},
                onSome: (recall) => {
                  ctx.store.setHistory(recall.state)
                  ctx.store.setComposer(recall.text)
                },
              },
            )
          }
          if (applied.state.mode === "insert") ctx.store.focusComposer()
        },
      })
      return
    }
  }
  // ctrl+o: expand/collapse the newest tool block's output in the story.
  if (key.ctrl === true && key.name === "o") {
    ctx.store.toggleToolExpand()
    return
  }
  // ctrl+n / ctrl+p: cycle the live /search (plain n/N would type into the
  // focused composer). The view follows store.search's current hit.
  if (key.ctrl === true && (key.name === "n" || key.name === "p")) {
    Option.match(ctx.store.search(), {
      onNone: () => {},
      onSome: (active) => {
        const next = cycleSearch(active, key.name === "n" ? 1 : -1)
        ctx.store.setSearch(Option.some(next))
        ctx.store.setNotice(searchNotice(next))
      },
    })
    return
  }
  // ↑/↓ prompt recall — engages only on an empty composer (or while the
  // recalled entry is still shown verbatim); mid-edit, the key falls
  // through to the textarea untouched.
  if (key.name === "up" || key.name === "down") {
    Option.match(recallStep(ctx.store.history(), key.name, ctx.store.composerText()), {
      onNone: () => {},
      onSome: (recall) => {
        ctx.store.setHistory(recall.state)
        ctx.store.setComposer(recall.text)
      },
    })
    return
  }
  // Tab completes a `:` command in the composer (shell-style). No overlay is
  // open here, so the composer owns the key; a non-command line is a no-op.
  if (key.name === "tab") {
    Option.match(completeCommand(ctx.store.composerText()), {
      onNone: () => {},
      onSome: (completed) => ctx.store.setComposer(completed),
    })
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

