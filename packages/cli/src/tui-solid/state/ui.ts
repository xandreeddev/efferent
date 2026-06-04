import { createSignal, type Accessor } from "solid-js"

export type FocusPane = "conversation" | "side" | "input"
export type UiMode = "insert" | "normal" | "visual"

/**
 * UI-chrome slice: which pane is focused, the vim mode, the zoom flag, a
 * one-shot `gPending` latch (for `gg`-style two-stroke motions), and the input
 * buffer mirror. Purely presentational; nothing here crosses into Effect.
 */
export interface UiSlice {
  readonly focus: Accessor<FocusPane>
  readonly setFocus: (f: FocusPane) => void
  readonly mode: Accessor<UiMode>
  readonly setMode: (m: UiMode) => void
  readonly input: Accessor<string>
  readonly setInput: (t: string) => void
  /** The focused read-only pane is maximized (fills the middle region). */
  readonly zoomed: Accessor<boolean>
  readonly setZoomed: (b: boolean) => void
  /** A `g` was pressed and is awaiting a second stroke (`gg` → top). */
  readonly gPending: Accessor<boolean>
  readonly setGPending: (b: boolean) => void
}

export const createUiSlice = (): UiSlice => {
  const [focus, setFocusSig] = createSignal<FocusPane>("input")
  const [mode, setModeSig] = createSignal<UiMode>("insert")
  const [input, setInputSig] = createSignal("")
  const [zoomed, setZoomedSig] = createSignal(false)
  const [gPending, setGPendingSig] = createSignal(false)

  return {
    focus,
    setFocus: (f) => setFocusSig(f),
    mode,
    setMode: (m) => setModeSig(m),
    input,
    setInput: (t) => setInputSig(t),
    zoomed,
    setZoomed: (b) => setZoomedSig(b),
    gPending,
    setGPending: (b) => setGPendingSig(b),
  }
}
