import { createSignal, type Accessor } from "solid-js"
import { emptyHistory, type PromptHistory } from "../presentation/promptHistory.js"

export type FocusPane = "chat" | "tree" | "input"
export type UiMode = "insert" | "normal" | "visual"

/**
 * UI-chrome slice: which pane is focused, the vim mode, a one-shot `gPending`
 * latch (for `gg`-style two-stroke motions), and the input buffer mirror.
 * Purely presentational; nothing here crosses into Effect.
 */
export interface UiSlice {
  readonly focus: Accessor<FocusPane>
  readonly setFocus: (f: FocusPane) => void
  readonly mode: Accessor<UiMode>
  readonly setMode: (m: UiMode) => void
  readonly input: Accessor<string>
  readonly setInput: (t: string) => void
  /** A `g` was pressed and is awaiting a second stroke (`gg` → top). */
  readonly gPending: Accessor<boolean>
  readonly setGPending: (b: boolean) => void
  /** Highlighted row in the `:` command palette (↑/↓ move it; Tab/↵ act on it). */
  readonly paletteIndex: Accessor<number>
  readonly setPaletteIndex: (i: number) => void
  /** Sent-message history for ↑/↓ recall in the input (readline-style). */
  readonly history: Accessor<PromptHistory>
  readonly setHistory: (h: PromptHistory) => void
}

export const createUiSlice = (): UiSlice => {
  const [focus, setFocusSig] = createSignal<FocusPane>("input")
  const [mode, setModeSig] = createSignal<UiMode>("insert")
  const [input, setInputSig] = createSignal("")
  const [gPending, setGPendingSig] = createSignal(false)
  const [paletteIndex, setPaletteIndexSig] = createSignal(0)
  const [history, setHistorySig] = createSignal<PromptHistory>(emptyHistory)

  return {
    focus,
    setFocus: (f) => setFocusSig(f),
    mode,
    setMode: (m) => setModeSig(m),
    input,
    setInput: (t) => setInputSig(t),
    gPending,
    setGPending: (b) => setGPendingSig(b),
    paletteIndex,
    setPaletteIndex: (i) => setPaletteIndexSig(i),
    history,
    setHistory: (h) => setHistorySig(h),
  }
}
