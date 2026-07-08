/**
 * A reusable, pure single-line text-input overlay — the sibling of
 * `selectBox.ts`, for typing a value (an API key, a pasted redirect URL).
 * When `mask` is set the value renders as bullets, so a secret never shows
 * on screen or in a screenshot (OPSEC). `PromptBody` renders it.
 */

export interface PromptState {
  readonly title: string
  /** The instruction line, e.g. "Paste your API key". */
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

/** What the value looks like on screen — bullets when masked. */
export const displayValue = (state: PromptState): string =>
  state.mask ? "•".repeat(state.value.length) : state.value
