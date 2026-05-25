/**
 * Extract a title from a markdown document.
 *
 * Returns the text of the first `# Heading` line, trimmed.
 * Falls back to "Untitled" when none is present.
 */
export const extractTitle = (markdown: string): string => {
  for (const line of markdown.split("\n")) {
    const match = /^#\s+(.+?)\s*$/.exec(line)
    if (match !== null && match[1] !== undefined) {
      return match[1].trim()
    }
  }
  return "Untitled"
}
