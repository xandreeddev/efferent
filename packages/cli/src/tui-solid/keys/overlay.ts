import type { ConversationId, ModelInfo } from "@efferent/core"
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
  beginEdit,
  cancelEdit,
  currentRow,
  editAppend,
  editBackspace,
  isEditing,
  moveSettings,
  type SettingsState,
} from "../presentation/settingsView.js"
import { applyModelSelection } from "../actions/model.js"
import { applyTheme } from "../actions/theme.js"
import { resumeConversation } from "../actions/session.js"
import {
  applyEffort,
  applySearchModel,
  commitMaxSteps,
  cycleEnumSetting,
  toggleAllowBash,
} from "../actions/settings.js"
import { advanceLogin, stopOAuthSession } from "../actions/login.js"
import {
  backToChoose,
  beginDenyReason,
  reasonAppend,
  reasonBackspace,
  type ApprovalState,
} from "../presentation/approvalView.js"
import type { SelectPurpose, TuiContext } from "../state/store.js"
import type { Key } from "./ParsedKey.js"

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
      const id = value as ConversationId | null | undefined
      if (id != null) void ctx.run(resumeConversation(store, id))
      return
    }
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
      void ctx.run(toggleAllowBash(store, row.value))
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

  if (o.kind === "select") {
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      store.closeOverlay()
      return true
    }
    if (key.name === "up" || key.name === "down") {
      store.setOverlay({ ...o, sel: moveSelect(o.sel, key.name) })
      return true
    }
    if (key.name === "return") {
      submitSelect(ctx, o.sel, o.purpose)
      return true
    }
    if (key.name === "backspace") {
      store.setOverlay({ ...o, sel: filterBackspace(o.sel) })
      return true
    }
    const ch = printable(key)
    if (ch !== undefined) {
      store.setOverlay({ ...o, sel: filterAppend(o.sel, ch) })
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

  return false
}
