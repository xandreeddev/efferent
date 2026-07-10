import { Option } from "effect"

/**
 * MINIMAL vi on the single-line composer — a fresh machine, not a port (the
 * old line's vi-lite was multi-line and never felt right). Deliberately
 * small and predictable:
 *
 * - insert (the default; the composer behaves exactly as without vi) and
 *   normal (Esc leaves insert; in normal the textarea is BLURRED, so keys
 *   can never leak into the buffer).
 * - motions: h l 0 $ w b · edits: x, dd, dw · inserts: i a I A ·
 *   j/k delegate to the prompt ring (the ↑/↓ recall — vim muscle memory).
 * - Esc IN normal falls through to the session's Esc (interrupt/clear) —
 *   one Esc rule, unchanged.
 *
 * Pure: the key layer owns focus/blur and applying the returned edit.
 */

export type ViMode = "insert" | "normal"

export interface ViState {
  readonly mode: ViMode
  /** A pending operator awaiting its motion ("d" for dd/dw, "z" for za). */
  readonly pending: Option.Option<"d" | "z">
}

export const initialVi: ViState = { mode: "insert", pending: Option.none() }

/** What the key layer applies after a normal-mode key. */
export interface ViEdit {
  readonly state: ViState
  /** New buffer text, when the edit changed it. */
  readonly text?: string
  /** New cursor offset, when it moved (also set alongside `text`). */
  readonly cursor?: number
  /** j/k: delegate to the history ring instead of moving. */
  readonly recall?: "up" | "down"
  /** za: toggle the story's tool-group folds. */
  readonly toggleFold?: boolean
}

const isWord = (ch: string): boolean => /\w/.test(ch)

/** The next word START strictly after `at` (vim `w`, line-local). */
export const nextWordStart = (text: string, at: number): number => {
  const chars = [...text]
  const found = chars.findIndex(
    (ch, index) =>
      index > at && isWord(ch) && (index === 0 || !isWord(chars[index - 1] ?? "")),
  )
  return found === -1 ? text.length : found
}

/** The previous word START strictly before `at` (vim `b`). */
export const prevWordStart = (text: string, at: number): number => {
  const chars = [...text]
  const starts = chars.flatMap((ch, index) =>
    index < at && isWord(ch) && (index === 0 || !isWord(chars[index - 1] ?? ""))
      ? [index]
      : [],
  )
  return starts[starts.length - 1] ?? 0
}

const clamp = (at: number, len: number): number => Math.max(0, Math.min(len, at))

const normal = (pending: Option.Option<"d" | "z"> = Option.none()): ViState => ({
  mode: "normal",
  pending,
})
const insert: ViState = { mode: "insert", pending: Option.none() }

/**
 * One NORMAL-mode key. `None` = not ours (an unknown key simply drops any
 * pending operator and stays put — vim's forgiving no-op, never a beep).
 */
export const viNormalStep = (
  state: ViState,
  key: string,
  text: string,
  cursor: number,
): Option.Option<ViEdit> => {
  const at = clamp(cursor, text.length)

  if (Option.isSome(state.pending)) {
    const operator = state.pending.value
    if (operator === "z") {
      return key === "a"
        ? Option.some({ state: normal(), toggleFold: true })
        : Option.some({ state: normal() })
    }
    if (key === "d") {
      return Option.some({ state: normal(), text: "", cursor: 0 })
    }
    if (key === "w") {
      const to = nextWordStart(text, at)
      return Option.some({
        state: normal(),
        text: text.slice(0, at) + text.slice(to),
        cursor: at,
      })
    }
    // Any other key cancels the operator (vim's forgiving no-op).
    return Option.some({ state: normal() })
  }

  if (key === "h") return Option.some({ state, cursor: clamp(at - 1, text.length) })
  if (key === "l") return Option.some({ state, cursor: clamp(at + 1, text.length) })
  if (key === "0") return Option.some({ state, cursor: 0 })
  if (key === "$") return Option.some({ state, cursor: text.length })
  if (key === "w") return Option.some({ state, cursor: nextWordStart(text, at) })
  if (key === "b") return Option.some({ state, cursor: prevWordStart(text, at) })
  if (key === "j") return Option.some({ state, recall: "down" })
  if (key === "k") return Option.some({ state, recall: "up" })
  if (key === "x") {
    return text.length === 0
      ? Option.some({ state })
      : Option.some({
          state,
          text: text.slice(0, at) + text.slice(at + 1),
          cursor: clamp(at, text.length - 1),
        })
  }
  if (key === "d") return Option.some({ state: normal(Option.some("d")) })
  if (key === "z") return Option.some({ state: normal(Option.some("z")) })
  if (key === "i") return Option.some({ state: insert, cursor: at })
  if (key === "a") return Option.some({ state: insert, cursor: clamp(at + 1, text.length) })
  if (key === "I") return Option.some({ state: insert, cursor: 0 })
  if (key === "A") return Option.some({ state: insert, cursor: text.length })
  return Option.none()
}
