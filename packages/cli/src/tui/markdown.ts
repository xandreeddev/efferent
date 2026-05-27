import { ansi } from "./terminal.js"

/**
 * Minimal markdown → ANSI converter. Supports:
 *  - headings (#, ##, ###) — bold + colour
 *  - **bold** and *italic*
 *  - `inline code`
 *  - ```fenced``` code blocks (dim, monospaced look)
 *  - bullet lists (- or *)
 *  - links [text](url) — underlined text + dim url
 *
 * No tables, no nested blockquotes. Good enough for typical agent
 * responses; falls back to plain text when uncertain.
 */

const renderInline = (line: string): string => {
  let out = ""
  let i = 0
  while (i < line.length) {
    // Inline code
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1)
      if (end !== -1) {
        out += ansi.bgDarkGray + ansi.fgBrightCyan + line.slice(i + 1, end) + ansi.reset
        i = end + 1
        continue
      }
    }
    // Bold **x**
    if (line[i] === "*" && line[i + 1] === "*") {
      const end = line.indexOf("**", i + 2)
      if (end !== -1) {
        out += ansi.bold + line.slice(i + 2, end) + ansi.reset
        i = end + 2
        continue
      }
    }
    // Italic *x*
    if (line[i] === "*") {
      const end = line.indexOf("*", i + 1)
      if (end !== -1 && end !== i + 1) {
        out += ansi.italic + line.slice(i + 1, end) + ansi.reset
        i = end + 1
        continue
      }
    }
    // Link [text](url)
    if (line[i] === "[") {
      const textEnd = line.indexOf("]", i + 1)
      if (textEnd !== -1 && line[textEnd + 1] === "(") {
        const urlEnd = line.indexOf(")", textEnd + 2)
        if (urlEnd !== -1) {
          const text = line.slice(i + 1, textEnd)
          const url = line.slice(textEnd + 2, urlEnd)
          out +=
            ansi.underline +
            ansi.fgBrightBlue +
            text +
            ansi.reset +
            " " +
            ansi.dim +
            url +
            ansi.reset
          i = urlEnd + 1
          continue
        }
      }
    }
    out += line[i]
    i++
  }
  return out
}

export const renderMarkdown = (text: string): string[] => {
  const out: string[] = []
  const lines = text.split("\n")
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence
      out.push(ansi.dim + "─".repeat(20) + ansi.reset)
      continue
    }
    if (inFence) {
      out.push(ansi.dim + line + ansi.reset)
      continue
    }
    if (line.startsWith("### ")) {
      out.push(ansi.bold + ansi.fgBrightCyan + line.slice(4) + ansi.reset)
      continue
    }
    if (line.startsWith("## ")) {
      out.push(ansi.bold + ansi.fgBrightMagenta + line.slice(3) + ansi.reset)
      continue
    }
    if (line.startsWith("# ")) {
      out.push(ansi.bold + ansi.fgBrightYellow + line.slice(2) + ansi.reset)
      continue
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      out.push(
        ansi.fgGray + "• " + ansi.reset + renderInline(line.slice(2)),
      )
      continue
    }
    if (/^\s*\d+\.\s/.test(line)) {
      out.push(renderInline(line))
      continue
    }
    out.push(renderInline(line))
  }
  return out
}
