/**
 * Zero-dep markdown → {@link Html}. Covers what assistant prose actually uses:
 * paragraphs, ATX headings, fenced code blocks, inline code / bold / italic /
 * strikethrough / links, unordered + ordered lists, blockquotes, tables and
 * horizontal rules. Everything is escaped by construction (built through the
 * `html` template); links only keep safe hrefs. Not a spec renderer — a
 * predictable one.
 */
import { escapeHtml, html, join, raw, type Html } from "./html.js"

const SAFE_HREF = /^(https?:\/\/|\/|#|mailto:)/i

/** Inline spans: code first (its content is literal), then links, emphasis. */
const renderInline = (text: string): Html => {
  const parts: Html[] = []
  let rest = text
  // Tokenize inline code spans first so nothing inside them is styled.
  const codeRe = /`([^`]+)`/
  while (rest.length > 0) {
    const m = codeRe.exec(rest)
    if (m === null || m.index === undefined) {
      parts.push(renderEmphasis(rest))
      break
    }
    if (m.index > 0) parts.push(renderEmphasis(rest.slice(0, m.index)))
    parts.push(html`<code class="ef-code">${m[1] ?? ""}</code>`)
    rest = rest.slice(m.index + m[0].length)
  }
  return join(parts)
}

const renderEmphasis = (text: string): Html => {
  // Order matters: links, then bold, then italic, then strikethrough.
  let out = escapeHtml(text)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => {
    if (!SAFE_HREF.test(href)) return whole
    const external = /^https?:\/\//i.test(href)
    const extra = external ? ` target="_blank" rel="noopener noreferrer"` : ""
    // label + href are substrings of the already-escaped `out` — safe as-is.
    return `<a class="ef-link" href="${href}"${extra}>${label}</a>`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>")
  return raw(out)
}

interface Block {
  readonly kind: "p" | "h" | "code" | "ul" | "ol" | "quote" | "table" | "hr"
  readonly level?: number
  readonly lang?: string
  readonly lines: string[]
}

const parseBlocks = (src: string): Block[] => {
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    if (line.trim() === "") {
      i++
      continue
    }
    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence !== null) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "")
        i++
      }
      i++ // closing fence (or EOF)
      const block: Block = { kind: "code", lines: body, ...(fence[1] !== "" && { lang: fence[1] as string }) }
      blocks.push(block)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push({ kind: "h", level: (heading[1] ?? "#").length, lines: [heading[2] ?? ""] })
      i++
      continue
    }
    if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push({ kind: "hr", lines: [] })
      i++
      continue
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        body.push((lines[i] ?? "").replace(/^>\s?/, ""))
        i++
      }
      blocks.push({ kind: "quote", lines: body })
      continue
    }
    if (/^[-*+]\s+/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^[-*+]\s+/.test(lines[i] ?? "")) {
        body.push((lines[i] ?? "").replace(/^[-*+]\s+/, ""))
        i++
      }
      blocks.push({ kind: "ul", lines: body })
      continue
    }
    if (/^\d+[.)]\s+/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i] ?? "")) {
        body.push((lines[i] ?? "").replace(/^\d+[.)]\s+/, ""))
        i++
      }
      blocks.push({ kind: "ol", lines: body })
      continue
    }
    if (line.includes("|") && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
      const body: string[] = [line]
      i++ // separator row — consumed, not rendered
      i++
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        body.push(lines[i] ?? "")
        i++
      }
      blocks.push({ kind: "table", lines: body })
      continue
    }
    // Paragraph: greedy until a blank line or a structural opener.
    const body: string[] = []
    while (i < lines.length) {
      const l = lines[i] ?? ""
      if (
        l.trim() === "" ||
        /^```/.test(l) ||
        /^#{1,6}\s/.test(l) ||
        /^>\s?/.test(l) ||
        /^[-*+]\s+/.test(l) ||
        /^\d+[.)]\s+/.test(l)
      )
        break
      body.push(l)
      i++
    }
    blocks.push({ kind: "p", lines: body })
  }
  return blocks
}

const splitRow = (row: string): string[] =>
  row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim())

const renderBlock = (b: Block): Html => {
  switch (b.kind) {
    case "h": {
      const level = Math.min(Math.max(b.level ?? 1, 1), 6)
      const tag = `h${level}`
      return html`${raw(`<${tag} class="ef-heading">`)}${renderInline(b.lines[0] ?? "")}${raw(`</${tag}>`)}`
    }
    case "code":
      return html`<pre class="ef-codeblock"${b.lang !== undefined ? raw(` data-lang="${escapeHtml(b.lang)}"`) : ""}><code>${b.lines.join("\n")}</code></pre>`
    case "ul":
      return html`<ul class="ef-list">${b.lines.map((l) => html`<li>${renderInline(l)}</li>`)}</ul>`
    case "ol":
      return html`<ol class="ef-list">${b.lines.map((l) => html`<li>${renderInline(l)}</li>`)}</ol>`
    case "quote":
      return html`<blockquote class="ef-quote">${renderInline(b.lines.join("\n"))}</blockquote>`
    case "hr":
      return html`<hr class="ef-hr" />`
    case "table": {
      const [head, ...rows] = b.lines
      const headerCells = splitRow(head ?? "").map((c) => html`<th>${renderInline(c)}</th>`)
      const bodyRows = rows.map(
        (r) => html`<tr>${splitRow(r).map((c) => html`<td>${renderInline(c)}</td>`)}</tr>`,
      )
      return html`<table class="ef-table"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`
    }
    case "p":
      return html`<p>${renderInline(b.lines.join("\n"))}</p>`
  }
}

/** Render markdown prose to Html (safe by construction). */
export const renderMarkdown = (src: string): Html => join(parseBlocks(src).map(renderBlock))
