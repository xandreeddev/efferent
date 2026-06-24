import type { ConversationId, ModelInfo, NamedConn } from "@xandreed/sdk-core"
import {
  filterAppend,
  filterBackspace,
  moveSelect,
  selectedValue,
  type SelectState,
} from "../presentation/selectBox.js"
import {
  loginAppend,
  loginBack,
  loginBackspace,
  loginMove,
} from "../presentation/loginFlow.js"
import {
  onboardingMove,
  onboardingAppend,
  onboardingBackspace,
  startOnboarding,
  databaseConfirmRemove,
  databaseCancelRemove,
} from "../presentation/onboardingFlow.js"
import {
  advanceOnboardingStep,
  onboardingBack,
  finishOnboarding,
  removeOnboardingDatabase,
} from "../actions/onboarding.js"
import { LOCAL_DB_NAME } from "@xandreed/sdk-core"
import {
  beginEdit,
  cancelEdit,
  currentRow,
  editAppend,
  editBackspace,
  isEditing,
  moveSettings,
  type SettingsState,
} from "../presentation/settingsView.js"
import { applyModelSelection, applyRoleModelSelection } from "../actions/model.js"
import { applyTheme } from "../actions/theme.js"
import { setTheme } from "../state/theme.js"
import { Effect } from "effect"
import { refreshNav } from "../actions/contextTree.js"
import { resumeConversation, resumeFromBrowser } from "../actions/session.js"
import {
  resumeClearFilter,
  resumeCycleTab,
  resumeFilterAppend,
  resumeFilterBackspace,
  resumeMove,
  selectedResume,
} from "../presentation/resumeBrowser.js"
import {
  applyDatabasePick,
  applyEffort,
  applySearchModel,
  commitMaxSteps,
  cycleEnumSetting,
  toggleBooleanSetting,
} from "../actions/settings.js"
import { advanceLogin, logout, stopOAuthSession } from "../actions/login.js"
import {
  backToChoose,
  beginDenyReason,
  reasonAppend,
  reasonBackspace,
  type ApprovalState,
} from "../presentation/approvalView.js"
import type { SelectPurpose, TuiContext } from "../state/store.js"
import type { Key } from "./ParsedKey.js"

/**
 * Live-preview the highlighted theme by flipping the active-theme signal (NOT
 * persisted) — the whole UI, including the `ThemePreview` panel, recolours. Used
 * by the theme picker (onboarding step + the `:theme` modal). A no-op for any
 * non-string value, so it's safe to call on every move regardless of purpose.
 */
const previewTheme = (sel: SelectState<unknown>): void => {
  const value = sel.matches[sel.selected]?.value
  if (typeof value === "string") setTheme(value)
}

/** Revert a live theme preview to the option flagged `active` — the theme that
 *  was in effect when the picker opened. Cancels the preview without persisting. */
const revertThemePreview = (sel: SelectState<unknown>): void => {
  const entry = sel.all.find((o) => o.active === true)?.value
  if (typeof entry === "string") setTheme(entry)
}

/** The printable character a key types into a filter, or undefined. */
const printable = (key: Key): string | undefined => {
  if (key.ctrl || key.meta) return undefined
  if (key.name === "space") return " "
  if (key.name.length === 1) return key.shift ? key.name.toUpperCase() : key.name
  return undefined
}

/** Submit a select overlay: dispatch by purpose (casting the erased value), then close. */
const submitSelect = (ctx: TuiContext, sel: SelectState<unknown>, purpose: SelectPurpose): void => {
  const { store } = ctx
  const value = selectedValue(sel)
  store.closeOverlay()
  switch (purpose.tag) {
    case "model":
      // A role picker configures that tier (null = follow main); the plain
      // picker switches main itself.
      if (purpose.role !== undefined) {
        if (value !== undefined)
          void ctx.run(applyRoleModelSelection(store, purpose.role, value as ModelInfo | null))
        return
      }
      if (value !== undefined) void ctx.run(applyModelSelection(store, value as ModelInfo))
      return
    case "effort":
      if (value !== undefined) void ctx.run(applyEffort(store, purpose.key, value as string))
      return
    case "search":
      // `undefined` is a valid pick here (the auto default).
      void ctx.run(applySearchModel(store, value as string | undefined))
      return
    case "theme":
      if (value !== undefined) void ctx.run(applyTheme(store, value as string))
      return
    case "conversation": {
      // A ConversationId resumes it; `null` (start new) or no pick → stay fresh.
      // The nav refresh keeps the agents/sessions root row on the NEW session.
      const id = value as ConversationId | null | undefined
      if (id != null)
        void ctx.run(
          resumeConversation(store, id).pipe(
            Effect.zipRight(refreshNav(store, id).pipe(Effect.catchAll(() => Effect.void))),
          ),
        )
      return
    }
    case "database":
      // Make the chosen connection active (switch live + carry the conversation).
      if (value !== undefined) void ctx.run(applyDatabasePick(store, value as NamedConn, store.status().cwd))
      return
    case "logout":
      // Forget the highlighted provider's credential (same path as `:logout <p>`).
      if (value !== undefined) void ctx.run(logout(store, value as string))
      return
  }
}

/** Enter on a non-editing settings row: toggle / begin-edit / cycle / no-op. */
const settingsActivate = (ctx: TuiContext, state: SettingsState): void => {
  const { store } = ctx
  const row = currentRow(state)
  if (row === undefined) return
  switch (row.kind) {
    case "number":
      store.setOverlay({ kind: "settings", state: beginEdit(state) })
      return
    case "boolean":
      void ctx.run(toggleBooleanSetting(store, row.key, row.value))
      return
    case "enum": {
      if (row.options === undefined) return
      const idx = row.options.indexOf(row.value)
      const next = row.options[(idx + 1) % row.options.length] ?? ""
      void ctx.run(cycleEnumSetting(store, row.key, next))
      return
    }
    case "readonly":
      return // a hint points at :model / :search / :db
  }
}

/** Enter while editing the inline number row: commit if valid, else cancel. */
const settingsCommitEdit = (ctx: TuiContext, state: SettingsState): void => {
  const { store } = ctx
  const row = currentRow(state)
  const num = Number(state.editBuffer ?? "")
  if (row?.key === "maxSteps" && Number.isFinite(num) && num >= 1) {
    void ctx.run(commitMaxSteps(store, Math.floor(num)))
  } else {
    store.setOverlay({ kind: "settings", state: cancelEdit(state) })
  }
}

/**
 * Route a key to the open overlay (a modal owns all input while visible).
 * Returns true iff it consumed the key — `keys/dispatch.ts` calls this first, so
 * nothing leaks to the panes. Esc / Ctrl-C close; ↑/↓ move; printable chars
 * filter; Backspace trims; Enter submits via `submitSelect`.
 */
export const overlayKey = (ctx: TuiContext, key: Key): boolean => {
  const { store } = ctx
  const o = store.overlay()
  if (o.kind === "none") return false

  if (o.kind === "shortcuts") {
    // A reference card: Esc / Ctrl-C / ? / q dismiss it; anything else is swallowed
    // so it can't leak to the panes while it's up.
    if (
      key.name === "escape" ||
      (key.ctrl && key.name === "c") ||
      key.name === "?" ||
      key.name === "q"
    ) {
      store.closeOverlay()
    }
    return true
  }

  if (o.kind === "resume") {
    const st = o.state
    if (key.name === "escape") {
      // esc clears the search first (agy "Go back / Clear search"), then closes.
      const cleared = resumeClearFilter(st)
      if (cleared === undefined) store.closeOverlay()
      else store.setOverlay({ kind: "resume", state: cleared })
      return true
    }
    if (key.ctrl && key.name === "c") {
      store.closeOverlay()
      return true
    }
    if (key.name === "tab" || key.name === "right") {
      store.setOverlay({ kind: "resume", state: resumeCycleTab(st, "right") })
      return true
    }
    if (key.name === "left") {
      store.setOverlay({ kind: "resume", state: resumeCycleTab(st, "left") })
      return true
    }
    if (key.name === "up" || key.name === "down") {
      store.setOverlay({ kind: "resume", state: resumeMove(st, key.name) })
      return true
    }
    if (key.name === "return") {
      const pick = selectedResume(st)
      if (pick === undefined) {
        store.closeOverlay()
      } else {
        void ctx.run(
          resumeFromBrowser(store, store.status().cwd, pick.conn, pick.active, pick.conv.id).pipe(
            Effect.zipRight(refreshNav(store, pick.conv.id).pipe(Effect.catchAll(() => Effect.void))),
          ),
        )
      }
      return true
    }
    if (key.name === "backspace") {
      store.setOverlay({ kind: "resume", state: resumeFilterBackspace(st) })
      return true
    }
    const ch = printable(key)
    if (ch !== undefined) {
      store.setOverlay({ kind: "resume", state: resumeFilterAppend(st, ch) })
      return true
    }
    return true // a modal owns all input while open
  }

  if (o.kind === "select") {
    const isTheme = o.purpose.tag === "theme"
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      if (isTheme) revertThemePreview(o.sel) // undo the live preview
      store.closeOverlay()
      return true
    }
    if (key.name === "up" || key.name === "down") {
      const sel = moveSelect(o.sel, key.name)
      store.setOverlay({ ...o, sel })
      if (isTheme) previewTheme(sel)
      return true
    }
    if (key.name === "return") {
      submitSelect(ctx, o.sel, o.purpose)
      return true
    }
    if (key.name === "backspace") {
      const sel = filterBackspace(o.sel)
      store.setOverlay({ ...o, sel })
      if (isTheme) previewTheme(sel)
      return true
    }
    const ch = printable(key)
    if (ch !== undefined) {
      const sel = filterAppend(o.sel, ch)
      store.setOverlay({ ...o, sel })
      if (isTheme) previewTheme(sel)
      return true
    }
    return true // swallow everything else while the modal is open
  }

  if (o.kind === "login") {
    const flow = o.flow
    if (key.name === "escape") {
      // Leaving the OAuth step cancels any in-flight callback server.
      if (flow.step === "oauth") void ctx.run(stopOAuthSession(store))
      const back = loginBack(flow)
      if (back === undefined) store.closeOverlay()
      else store.setOverlay({ kind: "login", flow: back })
      return true
    }
    if (key.ctrl && key.name === "c") {
      void ctx.run(stopOAuthSession(store))
      store.closeOverlay()
      return true
    }
    if (key.name === "up" || key.name === "down") {
      store.setOverlay({ kind: "login", flow: loginMove(flow, key.name) })
      return true
    }
    if (key.name === "return") {
      advanceLogin(ctx, flow)
      return true
    }
    if (key.name === "backspace") {
      store.setOverlay({ kind: "login", flow: loginBackspace(flow) })
      return true
    }
    const ch = printable(key)
    if (ch !== undefined) {
      store.setOverlay({ kind: "login", flow: loginAppend(flow, ch) })
      return true
    }
    return true
  }

  if (o.kind === "approval") {
    const state: ApprovalState = o.state
    if (state.mode === "deny") {
      if (key.name === "escape") {
        store.setOverlay({ kind: "approval", state: backToChoose(state) })
        return true
      }
      if (key.name === "return") {
        const reason = state.reason.trim()
        ctx.resolveApproval(reason.length > 0 ? { kind: "deny", reason } : { kind: "deny" })
        return true
      }
      if (key.name === "backspace") {
        store.setOverlay({ kind: "approval", state: reasonBackspace(state) })
        return true
      }
      const ch = printable(key)
      if (ch !== undefined) {
        store.setOverlay({ kind: "approval", state: reasonAppend(state, ch) })
      }
      return true
    }
    // choose mode: three of the four answers are rules. Esc is a deny — the
    // safe default for "get this out of my face" must not run the command.
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      ctx.resolveApproval({ kind: "deny" })
      return true
    }
    if (key.name === "a") {
      ctx.resolveApproval({ kind: "allow", scope: "once" })
      return true
    }
    if (key.name === "s") {
      ctx.resolveApproval({ kind: "allow", scope: "session" })
      return true
    }
    if (key.name === "p") {
      ctx.resolveApproval({ kind: "allow", scope: "project" })
      return true
    }
    if (key.name === "d") {
      store.setOverlay({ kind: "approval", state: beginDenyReason(state) })
      return true
    }
    return true // a modal owns all input while open
  }

  if (o.kind === "settings") {
    const state = o.state
    const editing = isEditing(state)
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      // Esc cancels an inline edit first; otherwise closes the modal.
      if (editing) store.setOverlay({ kind: "settings", state: cancelEdit(state) })
      else store.closeOverlay()
      return true
    }
    if (editing) {
      if (key.name === "return") {
        settingsCommitEdit(ctx, state)
        return true
      }
      if (key.name === "backspace") {
        store.setOverlay({ kind: "settings", state: editBackspace(state) })
        return true
      }
      const ch = printable(key)
      if (ch !== undefined) store.setOverlay({ kind: "settings", state: editAppend(state, ch) })
      return true
    }
    if (key.name === "up" || key.name === "down") {
      store.setOverlay({ kind: "settings", state: moveSettings(state, key.name) })
      return true
    }
    if (key.name === "return") {
      settingsActivate(ctx, state)
      return true
    }
    return true
  }

  if (o.kind === "onboarding") {
    const state = o.state

    // A pending DB-delete confirmation owns input: ↵ removes, esc cancels,
    // anything else is swallowed (so the confirm stays put). MUST precede the
    // general Esc/Go-Back handler below, or esc would navigate away mid-confirm.
    if (state.step === "database" && state.connect === undefined && state.confirmRemove !== undefined) {
      if (key.name === "return") {
        void ctx.run(removeOnboardingDatabase(store, state))
        return true
      }
      if (key.name === "escape") {
        store.setOverlay({ kind: "onboarding", state: databaseCancelRemove(state) })
        return true
      }
      return true
    }

    // Esc = Go Back (agy convention). On the first screen (the scope picker)
    // there's nowhere back to go: close if already signed in, else exit.
    if (key.name === "escape") {
      // Scope picker is the FIRST screen — nowhere back: close if already signed
      // in, else exit.
      if (state.step === "scope") {
        const hasCreds = state.statuses.some((s) => s.configured !== undefined)
        if (hasCreds) store.closeOverlay()
        else ctx.exit()
        return true
      }
      if (state.step === "login") {
        const flow = state.flow
        if (flow.step === "oauth") void ctx.run(stopOAuthSession(store))
        const back = loginBack(flow)
        if (back !== undefined) {
          store.setOverlay({ kind: "onboarding", state: { ...state, flow: back } })
        } else {
          // Back out of login → the scope picker (step 1), restoring the
          // scope chosen on the way in (stashed on the run handle).
          store.setOverlay({
            kind: "onboarding",
            state: startOnboarding(state.statuses, store.run.getConfigScope()),
          })
        }
        return true
      }
      // model / fast / theme / complete → step back to the previous screen.
      // Leaving the theme step undoes its live preview first.
      if (state.step === "theme") revertThemePreview(state.sel)
      void ctx.run(onboardingBack(store, state))
      return true
    }

    if (key.ctrl && key.name === "c") {
      const hasCreds = state.statuses.some((s) => s.configured !== undefined)
      if (hasCreds) {
        // Already signed in → Ctrl-C just dismisses the onboarding overlay.
        if (state.step === "login" && state.flow.step === "oauth") {
          void ctx.run(stopOAuthSession(store))
        }
        store.closeOverlay()
        return true
      }
      // No creds → Ctrl-C would QUIT the app. Don't handle it here: fall through
      // to the main dispatch's proven 2×-to-quit (arms with a hint, second press
      // within 2s exits). Cancel any in-flight OAuth first.
      if (state.step === "login" && state.flow.step === "oauth") {
        void ctx.run(stopOAuthSession(store))
      }
      return false
    }

    if (state.step === "login") {
      const flow = state.flow
      if (key.name === "up" || key.name === "down") {
        store.setOverlay({ kind: "onboarding", state: { ...state, flow: loginMove(flow, key.name) } })
        return true
      }
      if (key.name === "return") {
        advanceLogin(ctx, flow)
        return true
      }
      if (key.name === "backspace") {
        store.setOverlay({ kind: "onboarding", state: { ...state, flow: loginBackspace(flow) } })
        return true
      }
      const ch = printable(key)
      if (ch !== undefined) {
        store.setOverlay({ kind: "onboarding", state: { ...state, flow: loginAppend(flow, ch) } })
        return true
      }
      return true
    }

    // In the DB manager (not the add/edit prompt), Ctrl-D arms a delete
    // CONFIRMATION for the highlighted configured connection. A non-letter trigger
    // on purpose: every printable key (incl. d/e) now flows to the filter, so the
    // manager is freely searchable (the old bare `d` deleted instead of searching).
    // Editing is `↵` (the manager's primary action — see advanceOnboardingStep).
    if (state.step === "database" && state.connect === undefined && key.ctrl && key.name === "d") {
      const item = selectedValue(state.sel)
      if (item !== undefined && item.tag === "use") {
        if (item.conn.name === LOCAL_DB_NAME) {
          store.toast("local always exists — press ↵ to change its path")
        } else {
          store.setOverlay({ kind: "onboarding", state: databaseConfirmRemove(state, item.conn.name) })
        }
      }
      return true
    }

    if (
      state.step === "scope" ||
      state.step === "mainModel" ||
      state.step === "codeModel" ||
      state.step === "fastModel" ||
      state.step === "theme" ||
      state.step === "database"
    ) {
      if (key.name === "up" || key.name === "down") {
        const next = onboardingMove(state, key.name)
        store.setOverlay({ kind: "onboarding", state: next })
        if (next.step === "theme") previewTheme(next.sel) // live recolour on highlight
        return true
      }
      if (key.name === "return") {
        void ctx.run(advanceOnboardingStep(store, state))
        return true
      }
      if (key.name === "backspace") {
        const next = onboardingBackspace(state)
        store.setOverlay({ kind: "onboarding", state: next })
        if (next.step === "theme") previewTheme(next.sel)
        return true
      }
      const ch = printable(key)
      if (ch !== undefined) {
        const next = onboardingAppend(state, ch)
        store.setOverlay({ kind: "onboarding", state: next })
        if (next.step === "theme") previewTheme(next.sel)
        return true
      }
      return true
    }

    if (state.step === "complete") {
      if (key.name === "return") {
        void ctx.run(advanceOnboardingStep(store, state))
        return true
      }
      return true
    }

    return true
  }

  return false
}

/**
 * Append pasted text to whatever single-line text field the open overlay shows
 * (API-key / connection-string prompts, login, the deny-reason box, an inline
 * settings edit, or a select filter). Returns true if it consumed the paste, so
 * the caller can `preventDefault()` the event and stop the hidden composer
 * `<textarea>` from also receiving it. The `*Append` reducers are plain
 * `value + s` concatenations, so the whole pasted string inserts in one step.
 *
 * Why this is separate from `overlayKey`: OpenTUI delivers a paste as a single
 * bracketed-paste `paste` event, NOT as keypresses — so the per-key `printable`
 * routing never sees it. The native `<textarea>` subscribes to paste itself;
 * these custom prompt overlays don't, so pasting (e.g. an API key) did nothing.
 */
export const pasteIntoOverlay = (ctx: TuiContext, text: string): boolean => {
  const { store } = ctx
  if (text.length === 0) return false
  const o = store.overlay()
  switch (o.kind) {
    case "select": {
      const sel = filterAppend(o.sel, text)
      store.setOverlay({ ...o, sel })
      if (o.purpose.tag === "theme") previewTheme(sel)
      return true
    }
    case "login":
      store.setOverlay({ kind: "login", flow: loginAppend(o.flow, text) })
      return true
    case "onboarding":
      store.setOverlay({ kind: "onboarding", state: onboardingAppend(o.state, text) })
      return true
    case "resume":
      store.setOverlay({ kind: "resume", state: resumeFilterAppend(o.state, text) })
      return true
    case "settings":
      if (!isEditing(o.state)) return false
      store.setOverlay({ kind: "settings", state: editAppend(o.state, text) })
      return true
    case "approval":
      if (o.state.mode !== "deny") return false
      store.setOverlay({ kind: "approval", state: reasonAppend(o.state, text) })
      return true
    default:
      return false
  }
}
