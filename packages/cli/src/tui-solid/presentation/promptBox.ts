/**
 * A reusable, pure single-line text-input overlay — the sibling of
 * `selectBox.ts`, for typing a value (an API key, a pasted redirect URL).
 * Pure: state + reducers. When `mask` is set the value renders as bullets (so an
 * API key never shows on screen / in a screenshot — OPSEC); the OpenTUI
 * `PromptBox` component renders it.
 */

export interface PromptState {
  readonly title: string
  /** The instruction line, e.g. "Paste your Anthropic API key". */
  readonly prompt: string
  readonly value: string
  /** Render the value as bullets (API keys / secrets). */
  readonly mask: boolean
}

export const openPrompt = (
  title: string,
  prompt: string,
  mask = true,
  defaultValue = "",
): PromptState => ({ title, prompt, value: defaultValue, mask })

export const promptAppend = (state: PromptState, ch: string): PromptState => ({
  ...state,
  value: state.value + ch,
})

export const promptBackspace = (state: PromptState): PromptState => ({
  ...state,
  value: state.value.slice(0, -1),
})

export const promptValue = (state: PromptState): string => state.value

/** What the value looks like on screen — bullets when masked. */
export const displayValue = (state: PromptState): string =>
  state.mask ? "•".repeat(state.value.length) : state.value
