/**
 * A small markdown reader for the chat pane: model replies are mostly
 * paragraphs, lists, code and emphasis. It parses to a plain tree (tested
 * without a DOM) and builds elements with `createElement`/`textContent`, so
 * model text is never parsed as HTML. A half-streamed reply is fine: an
 * unterminated marker stays literal and an open code fence shows what it has.
 */

export type Inline =
  | { readonly t: "text"; readonly v: string }
  | { readonly t: "code"; readonly v: string }
  | { readonly t: "br" }
  | { readonly t: "strong"; readonly c: readonly Inline[] }
  | { readonly t: "em"; readonly c: readonly Inline[] }
  | { readonly t: "link"; readonly href: string; readonly c: readonly Inline[] }

export type Block =
  | { readonly t: "p"; readonly c: readonly Inline[] }
  | { readonly t: "h"; readonly level: number; readonly c: readonly Inline[] }
  | { readonly t: "code"; readonly lang: string; readonly v: string }
  | { readonly t: "list"; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | { readonly t: "quote"; readonly c: readonly Block[] }
  | { readonly t: "hr" }

const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)

export const parseInline = (source: string): Inline[] => {
  const out: Inline[] = []
  let buffer = ""
  const flush = () => { if (buffer) { out.push({ t: "text", v: buffer }); buffer = "" } }
  let i = 0
  while (i < source.length) {
    const ch = source[i]!
    const rest = source.slice(i)
    if (ch === "\\" && i + 1 < source.length && /[\\`*_[\]()#>~-]/.test(source[i + 1]!)) { buffer += source[i + 1]; i += 2; continue }
    if (ch === "\n") { flush(); out.push({ t: "br" }); i += 1; continue }
    if (ch === "`") {
      const end = source.indexOf("`", i + 1)
      if (end > i + 1) { flush(); out.push({ t: "code", v: source.slice(i + 1, end) }); i = end + 1; continue }
    }
    if (rest.startsWith("**") || rest.startsWith("__")) {
      const mark = rest.slice(0, 2)
      const end = source.indexOf(mark, i + 2)
      if (end > i + 2 && (mark === "**" || (!isWordChar(source[i - 1]) && !isWordChar(source[end + 2])))) {
        flush(); out.push({ t: "strong", c: parseInline(source.slice(i + 2, end)) }); i = end + 2; continue
      }
    }
    if ((ch === "*" || ch === "_") && source[i + 1] !== " " && source[i + 1] !== ch) {
      const end = source.indexOf(ch, i + 1)
      const wordOk = ch === "*" || (!isWordChar(source[i - 1]) && !isWordChar(source[end + 1]))
      if (end > i + 1 && source[end - 1] !== " " && wordOk) {
        flush(); out.push({ t: "em", c: parseInline(source.slice(i + 1, end)) }); i = end + 1; continue
      }
    }
    if (ch === "[") {
      const link = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.exec(rest)
      if (link) { flush(); out.push({ t: "link", href: link[2]!, c: parseInline(link[1]!) }); i += link[0].length; continue }
    }
    buffer += ch
    i += 1
  }
  flush()
  return out
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const BULLET = /^ {0,3}[-*+]\s+(.*)$/
const NUMBERED = /^ {0,3}\d{1,9}[.)]\s+(.*)$/
const RULE = /^ {0,3}([-*_])( ?\1){2,}\s*$/
const QUOTE = /^ {0,3}>\s?(.*)$/

export const parseMarkdown = (source: string): Block[] => {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let paragraph: string[] = []
  const endParagraph = () => {
    if (paragraph.length > 0) blocks.push({ t: "p", c: parseInline(paragraph.join("\n")) })
    paragraph = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      endParagraph()
      const marker = fence[1]!
      const body: string[] = []
      i += 1
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i]!)) { body.push(lines[i]!); i += 1 }
      i += 1 // the closing fence, or the end of a still-streaming reply
      blocks.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") })
      continue
    }
    if (line.trim() === "") { endParagraph(); i += 1; continue }
    const heading = HEADING.exec(line)
    if (heading) { endParagraph(); blocks.push({ t: "h", level: heading[1]!.length, c: parseInline(heading[2]!) }); i += 1; continue }
    if (RULE.test(line)) { endParagraph(); blocks.push({ t: "hr" }); i += 1; continue }
    if (QUOTE.test(line)) {
      endParagraph()
      const inner: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!)) { inner.push(QUOTE.exec(lines[i]!)![1]!); i += 1 }
      blocks.push({ t: "quote", c: parseMarkdown(inner.join("\n")) })
      continue
    }
    const bullet = BULLET.test(line)
    if (bullet || NUMBERED.test(line)) {
      endParagraph()
      const pattern = bullet ? BULLET : NUMBERED
      const items: Inline[][] = []
      while (i < lines.length) {
        const match = pattern.exec(lines[i]!)
        if (match) { items.push(parseInline(match[1]!)); i += 1; continue }
        // an indented line continues the item above it; anything else ends the list
        if (items.length > 0 && /^\s{2,}\S/.test(lines[i]!) && !BULLET.test(lines[i]!) && !NUMBERED.test(lines[i]!)) {
          items[items.length - 1] = [...items[items.length - 1]!, { t: "br" }, ...parseInline(lines[i]!.trim())]
          i += 1
          continue
        }
        break
      }
      blocks.push({ t: "list", ordered: !bullet, items })
      continue
    }
    paragraph.push(line)
    i += 1
  }
  endParagraph()
  return blocks
}

// ── DOM ───────────────────────────────────────────────────────────────────

const inlineNodes = (inlines: readonly Inline[]): Node[] =>
  inlines.map((node): Node => {
    switch (node.t) {
      case "text": return document.createTextNode(node.v)
      case "br": return document.createElement("br")
      case "code": { const el = document.createElement("code"); el.textContent = node.v; return el }
      case "strong": { const el = document.createElement("strong"); el.append(...inlineNodes(node.c)); return el }
      case "em": { const el = document.createElement("em"); el.append(...inlineNodes(node.c)); return el }
      case "link": {
        const el = document.createElement("a")
        el.href = node.href
        el.target = "_blank"
        el.rel = "noopener noreferrer"
        el.append(...inlineNodes(node.c))
        return el
      }
    }
  })

const blockNodes = (blocks: readonly Block[]): Node[] =>
  blocks.map((block): Node => {
    switch (block.t) {
      case "p": { const el = document.createElement("p"); el.append(...inlineNodes(block.c)); return el }
      case "h": { const el = document.createElement(`h${Math.min(6, block.level + 2)}`); el.append(...inlineNodes(block.c)); return el }
      case "hr": return document.createElement("hr")
      case "quote": { const el = document.createElement("blockquote"); el.append(...blockNodes(block.c)); return el }
      case "code": {
        const pre = document.createElement("pre")
        const code = document.createElement("code")
        if (block.lang) code.dataset.lang = block.lang
        code.textContent = block.v
        pre.append(code)
        return pre
      }
      case "list": {
        const el = document.createElement(block.ordered ? "ol" : "ul")
        for (const item of block.items) { const li = document.createElement("li"); li.append(...inlineNodes(item)); el.append(li) }
        return el
      }
    }
  })

/** Replace `into`'s content with `source` rendered as markdown. */
export const renderMarkdown = (into: HTMLElement, source: string): void => {
  into.replaceChildren(...blockNodes(parseMarkdown(source)))
}
