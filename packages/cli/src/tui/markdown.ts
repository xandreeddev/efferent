import { ansi, padRight, truncate, wrapAnsi } from "./terminal.js"

/**
 * Minimal markdown → ANSI converter, width-aware. Supports:
 *  - headings (#, ##, ###) — bold + colour
 *  - **bold**, *italic*, ***bold italic***, ~~strike~~, `inline code`
 *  - links [text](url) — underlined text + dim url
 *  - ```fenced``` code blocks — left gutter bar + subtle bg + language label
 *  - blockquotes (>, nested > >) — left bar, dim text
 *  - bullet and ordered (1.) lists, nested by 2-space indent
 *  - horizontal rules (---, ***, ___)
 *
 * Everything is wrapped to `cols` so long paragraphs/list items flow instead
 * of being hard-truncated. No tables, no syntax highlighting. Falls back to
 * plain wrapped text when uncertain.
 */

const renderInline = (line: string): string => {
  let out = ""
  let i = 0
  while (i < line.length) {
    // Inline code `x`
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1)
      if (end !== -1) {
        out += ansi.bgDarkGray + ansi.fgBrightCyan + line.slice(i + 1, end) + ansi.reset
        i = end + 1
        continue
      }
    }
    // Bold italic ***x***
    if (line[i] === "*" && line[i + 1] === "*" && line[i + 2] === "*") {
      const end = line.indexOf("***", i + 3)
      if (end !== -1) {
        out += ansi.bold + ansi.italic + line.slice(i + 3, end) + ansi.reset
        i = end + 3
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
    // Strikethrough ~~x~~
    if (line[i] === "~" && line[i + 1] === "~") {
      const end = line.indexOf("~~", i + 2)
      if (end !== -1) {
        out += ansi.strikethrough + line.slice(i + 2, end) + ansi.reset
        i = end + 2
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

const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/
const HEADING_RE = /^(#{1,3})\s+(.*)$/
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/
const ORDERED_RE = /^(\s*)(\d+)\.\s+(.*)$/

const codeBar = `${ansi.fgGray}▏${ansi.reset}`

export const renderMarkdown = (text: string, cols: number): string[] => {
  const out: string[] = []
  const lines = text.split("\n")
  let inFence = false

  for (const raw of lines) {
    const trimmed = raw.trimStart()

    // Fenced code block — toggles on ``` ; opening fence shows a language label.
    if (trimmed.startsWith("```")) {
      if (!inFence) {
        inFence = true
        const lang = trimmed.slice(3).trim()
        out.push(`${codeBar}${lang.length > 0 ? `${ansi.dim} ${lang}${ansi.reset}` : ""}`)
      } else {
        inFence = false
      }
      continue
    }
    if (inFence) {
      const body = truncate(raw, Math.max(1, cols - 2))
      out.push(`${codeBar} ${ansi.bgCode}${padRight(body, Math.max(1, cols - 2))}${ansi.reset}`)
      continue
    }

    if (trimmed.length === 0) {
      out.push("")
      continue
    }

    // Horizontal rule — full width.
    if (HR_RE.test(trimmed)) {
      out.push(ansi.dim + "─".repeat(Math.max(1, cols)) + ansi.reset)
      continue
    }

    // Heading — re-apply the colour to every wrapped line.
    const h = HEADING_RE.exec(trimmed)
    if (h) {
      const level = h[1]!.length
      const color =
        level === 1
          ? ansi.fgBrightYellow
          : level === 2
            ? ansi.fgBrightMagenta
            : ansi.fgBrightCyan
      for (const w of wrapAnsi(renderInline(h[2]!), cols)) {
        out.push(`${ansi.bold}${color}${w}${ansi.reset}`)
      }
      continue
    }

    // Blockquote — strip nested `>` markers; bar per depth, dim text.
    if (trimmed.startsWith(">")) {
      let body = trimmed
      let depth = 0
      while (body.startsWith(">")) {
        depth++
        body = body.slice(1)
        if (body.startsWith(" ")) body = body.slice(1)
      }
      const bar = `${ansi.fgGray}${"▏ ".repeat(depth)}${ansi.reset}`
      for (const w of wrapAnsi(renderInline(body), Math.max(1, cols - depth * 2))) {
        out.push(`${bar}${ansi.dim}${w}${ansi.reset}`)
      }
      continue
    }

    // Lists — nesting from leading spaces (2 = one level); hanging-indent wrap.
    const bullet = BULLET_RE.exec(raw)
    const ordered = bullet ? null : ORDERED_RE.exec(raw)
    const list = bullet ?? ordered
    if (list) {
      const depth = Math.floor(list[1]!.length / 2)
      const indent = "  ".repeat(depth)
      const marker = bullet ? (depth % 2 === 0 ? "• " : "◦ ") : `${ordered![2]}. `
      const contIndent = indent + " ".repeat(marker.length)
      const textWidth = Math.max(1, cols - indent.length - marker.length)
      const body = bullet ? bullet[3]! : ordered![3]!
      const wrapped = wrapAnsi(renderInline(body), textWidth)
      wrapped.forEach((w, idx) => {
        out.push(
          idx === 0
            ? `${indent}${ansi.fgGray}${marker}${ansi.reset}${w}`
            : `${contIndent}${w}`,
        )
      })
      continue
    }

    // Paragraph.
    for (const w of wrapAnsi(renderInline(raw), cols)) out.push(w)
  }

  return out
}
