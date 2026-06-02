/**
 * A reusable, pure single-line text-input overlay — the sibling of
 * `selectBox.ts`, for typing a value (an API key, a pasted redirect URL).
 * Pure: state + reducers + an `OverlayLine[]` renderer composited by
 * `render.ts`. When `mask` is set the value renders as bullets (so an API key
 * never shows on screen / in a screenshot — OPSEC).
 */

import type { OverlayLine } from "./modal.js"
import { ansi, padRight, truncate, visibleLength } from "./terminal.js"

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
): PromptState => ({ title, prompt, value: "", mask })

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

/** Render the prompt box as a centered overlay (mirrors `renderSelectBox`). */
export const renderPromptBox = (
  state: PromptState,
  termRows: number,
  termCols: number,
): OverlayLine[] => {
  const boxWidth = Math.min(76, Math.max(40, termCols - 6))
  const innerWidth = boxWidth - 4
  const totalLines = 7 // title + prompt + blank + input + sep + hints, framed
  const top = Math.max(1, Math.floor((termRows - totalLines) / 2))
  const left = Math.max(1, Math.floor((termCols - boxWidth) / 2))
  const horiz = "─".repeat(boxWidth - 2)

  const fill = (s: string): string =>
    `${ansi.bgDarkGray}${ansi.fgWhite}${padRight(s, boxWidth)}${ansi.reset}`
  const span = (style: string, text: string): string =>
    `${style}${text}${ansi.reset}${ansi.bgDarkGray}${ansi.fgWhite}`
  const row = (inner: string): string => fill(`│ ${padRight(inner, innerWidth)} │`)

  const shown = displayValue(state)
  // Keep the tail visible (with the cursor) when the value overflows.
  const room = innerWidth - 1
  const tail = visibleLength(shown) > room ? shown.slice(shown.length - room) : shown

  const out: OverlayLine[] = []
  let r = top
  const emit = (content: string) => {
    out.push({ row: r, col: left, content })
    r += 1
  }

  emit(fill(`╭${horiz}╮`))
  emit(row(span(ansi.fgBrightCyan + ansi.bold, truncate(state.title, innerWidth))))
  emit(row(span(ansi.fgGray, truncate(state.prompt, innerWidth))))
  emit(fill(`├${horiz}┤`))
  emit(
    row(
      `${ansi.bgDarkGray}${ansi.fgWhite}${truncate(tail, room)}${span(
        ansi.fgBrightGreen,
        "█",
      )}`,
    ),
  )
  emit(fill(`├${horiz}┤`))
  emit(row(span(ansi.fgGray, "↵ submit · esc cancel")))
  emit(fill(`╰${horiz}╯`))
  return out
}
