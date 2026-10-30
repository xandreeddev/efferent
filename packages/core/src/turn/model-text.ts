/**
 * The shared frames of text the model reads that no user typed: host notes,
 * untrusted text inside a named tag, and counted clip markers. Pure string
 * functions; every package that writes such text uses these.
 */

/**
 * Text the host, not the user, adds as a user-role message.
 *
 * @public
 */
export const hostNote = (text: string): string => `[Host note: ${text}]`

/**
 * The marker a clip leaves in place of the characters it dropped.
 *
 * @public
 */
export const clippedMarker = (dropped: number): string => `[… ${dropped} characters clipped]`

/**
 * `text` with every opening or closing `tag` in it, in any case and
 * spacing, made inert (`</TASK-OUTPUT >` becomes `</TASK_OUTPUT >`), so it
 * cannot close or reopen the frame it is put in. The tag is a
 * lowercase name with a hyphen in it.
 *
 * @public
 */
export const escapeFrame = (tag: string, text: string): string =>
  text.replace(new RegExp(`<\\s*/?\\s*${tag}(?![\\w-])[^>]*>`, "gi"), (found) => found.replaceAll("-", "_"))

/** Untrusted `text` inside `<tag>…</tag>`, each on its own line, that it cannot close early. */
export const framed = (tag: string, text: string): string => `<${tag}>\n${escapeFrame(tag, text)}\n</${tag}>`

/**
 * `text` in at most `max` characters: its start, then a counted marker on
 * its own line when there is room for one (when there is not, only its
 * start).
 */
export const clipTo = (text: string, max: number): string => {
  if (text.length <= max) return text
  const room = max - clippedMarker(text.length).length - 1
  if (room <= 0) return text.slice(0, Math.max(0, max))
  return `${text.slice(0, room)}\n${clippedMarker(text.length - room)}`
}
