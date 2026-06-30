/**
 * Pull JSON objects out of a model's free-text reply — robustly. A model asked
 * for "a JSON verdict" may wrap it in a markdown fence, precede it with a
 * brace-heavy assessment (code in the prose), or trail it with explanation. The
 * naive `text.match(/\{[\s\S]*\}/)` grabs first-brace-to-last and breaks on any
 * of those (the exact bug that made the old verifier "could not parse a verdict").
 *
 * This does a **string-aware balanced-brace scan**: it walks the text tracking
 * brace depth while skipping over string literals (and their escapes), so a `{`
 * or `}` inside a JSON string value, inside prose, or inside fenced code never
 * miscounts. It returns every TOP-LEVEL `{…}` object, **last-first** — because the
 * verdict the prompt asks the model to end with is the trailing object, so a
 * caller that decodes the list in order and takes the first that validates lands
 * on the real verdict even after pages of brace-laden analysis.
 *
 * Markdown fences need no special handling: ```` ``` ```` are not braces, so the
 * balanced object inside a ```` ```json ```` block is found by the same scan.
 */
export const extractJsonObjects = (text: string): ReadonlyArray<string> => {
  const objects: string[] = []
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          objects.push(text.slice(start, i + 1))
          start = i // advance past this object (the outer for-loop's ++ moves on)
          break
        }
      }
    }
  }
  return objects.reverse()
}
