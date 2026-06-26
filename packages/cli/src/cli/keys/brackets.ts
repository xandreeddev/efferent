import type { Key } from "./ParsedKey.js"

/**
 * The vim "jump" motions bound to the bracket keys, used by every read-only
 * pane's dispatch: `{`/`}` step by paragraph (one logical row), `[`/`]` jump by
 * message (the next top-level unit).
 */
export type BracketMotion = "paragraph-prev" | "paragraph-next" | "message-prev" | "message-next"

/**
 * Map a bracket keystroke to its motion, tolerating the layout ambiguity: on a
 * US keyboard `{`/`}` are **Shift+`[`/`]`**, so a parser may deliver them either
 * as `name:"{"/"}"` *or* as `name:"[" /"]"` with `shift:true`. We accept both.
 * The unshifted brackets are the message step; the shifted ones (the braces) are
 * the paragraph step. Returns `undefined` for any non-bracket key.
 */
export const bracketMotion = (key: Key): BracketMotion | undefined => {
  if (key.ctrl || key.meta) return undefined
  // Shifted brackets / explicit braces → paragraph.
  if (key.name === "{" || (key.name === "[" && key.shift)) return "paragraph-prev"
  if (key.name === "}" || (key.name === "]" && key.shift)) return "paragraph-next"
  // Plain brackets → message.
  if (key.name === "[") return "message-prev"
  if (key.name === "]") return "message-next"
  return undefined
}
