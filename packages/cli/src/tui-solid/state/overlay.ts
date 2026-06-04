import { createSignal, type Accessor } from "solid-js"
import type { SelectState } from "../../tui/selectBox.js"
import type { LoginFlow } from "../../tui/loginFlow.js"
import type { SettingsState } from "../../tui/settingsView.js"

/** The mutable settings key an effort picker writes (mirrors `effortSettingKeyFor`). */
export type EffortSettingKey =
  | "anthropicThinkingEffort"
  | "openAiReasoningEffort"
  | "geminiThinkingLevel"
  | "openCodeThinkingMode"

/**
 * What a select overlay does on Enter — the submit dispatch (`keys/overlay.ts`)
 * reads this tag to pick the right action. Adding a new picker = one tag here +
 * one branch in `submitSelect`; the open/move/filter/close plumbing is shared.
 */
export type SelectPurpose =
  | { readonly tag: "model" }
  | { readonly tag: "effort"; readonly key: EffortSettingKey }
  | { readonly tag: "search" }

/**
 * The single active overlay (a modal floats above the panes and owns all input
 * while open). One discriminated signal replaces the old TUI's seven optional
 * overlay fields. The select-based pickers (`model`/`effort`/`search`) share the
 * `select` member — the value type is erased to `unknown` in the store and
 * re-narrowed at the submit boundary by `purpose`. `settings`/`login` land in
 * later Phase-D increments as their own members.
 */
export type Overlay =
  | { readonly kind: "none" }
  | {
      readonly kind: "select"
      readonly sel: SelectState<unknown>
      readonly purpose: SelectPurpose
    }
  | { readonly kind: "login"; readonly flow: LoginFlow }
  | { readonly kind: "settings"; readonly state: SettingsState }

export interface OverlaySlice {
  readonly overlay: Accessor<Overlay>
  readonly setOverlay: (o: Overlay) => void
  readonly closeOverlay: () => void
}

export const createOverlaySlice = (): OverlaySlice => {
  const [overlay, setOverlaySig] = createSignal<Overlay>({ kind: "none" })
  return {
    overlay,
    setOverlay: (o) => setOverlaySig(o),
    closeOverlay: () => setOverlaySig({ kind: "none" }),
  }
}
