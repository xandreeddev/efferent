/**
 * Allowlist sanitizer for agent-authored (`render_ui`) HTML — the security
 * boundary between model output and the browser DOM. Single-pass tolerant
 * tokenizer (no DOM, no deps), re-authored from the proven previous-line
 * spec as a PURE state machine driven by `Effect.iterate` (no `let`, no
 * loop statements — the same fold discipline as foundry's forge).
 *
 * Everything not explicitly allowed is dropped:
 * - drop WITH contents: script/style/iframe/object/embed/link/meta/base/
 *   svg/math/template/noscript
 * - unknown-but-benign tags are unwrapped (children kept, tag dropped)
 * - `on*`, `hx-on*`, `style`, `srcset`, `formaction` attributes stripped
 * - `href` https/relative only (external links get noopener+_blank);
 *   `src` https/relative; `hx-get`/`hx-post`/`action` must target `/action/…`
 * - `id`s may not spoof chrome (`ef-`/`blk-`/`ws-`/`ui-` prefixes)
 * - output tags are re-balanced (stray closes dropped, unclosed tags closed)
 */
import { Effect } from "effect"
import { escapeHtml, raw } from "./html.js"
import type { Html } from "./html.js"
import { ACTION_PREFIX } from "./contract.js"

export interface SanitizeResult {
  readonly html: Html
  /** What was removed — tag names, attribute names, or `attr=value` notes. */
  readonly dropped: ReadonlyArray<string>
}

export const SANITIZE_MAX_BYTES = 262_144

/** Elements whose entire content is discarded. */
const DROP_WITH_CONTENTS = new Set([
  "script", "style", "iframe", "object", "embed", "link", "meta", "base",
  "svg", "math", "template", "noscript",
])

/** Raw-text elements terminate at their FIRST close tag (no nesting). */
const RAW_TEXT = new Set(["script", "style", "noscript", "template"])

const ALLOWED_TAGS = new Set([
  "div", "span", "p",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "pre", "code", "blockquote",
  "strong", "em", "b", "i", "u", "s", "small", "br", "hr",
  "a", "img",
  "form", "input", "button", "select", "option", "optgroup", "textarea",
  "label", "fieldset", "legend",
  "progress", "meter", "details", "summary",
  "section", "article", "aside", "header", "footer", "figure", "figcaption",
  "mark", "kbd", "sub", "sup",
])

const VOID_TAGS = new Set(["br", "hr", "img", "input"])

const GLOBAL_ATTRS = new Set([
  "id", "class", "title", "role", "lang", "dir",
  "name", "value", "placeholder", "rows", "cols", "min", "max", "step",
  "checked", "selected", "disabled", "readonly", "required", "multiple",
  "for", "alt", "width", "height", "colspan", "rowspan", "open",
  "maxlength", "minlength", "pattern", "autocomplete",
])

/** htmx attributes agent UI may use (interactivity without scripts). */
const HTMX_ATTRS = new Set([
  "hx-get", "hx-post", "hx-vals", "hx-target", "hx-swap", "hx-include",
  "hx-trigger", "hx-indicator",
])

const URL_ACTION_ATTRS = new Set(["hx-get", "hx-post", "action"])

const INPUT_TYPES = new Set([
  "text", "number", "hidden", "radio", "checkbox", "range", "email",
  "submit", "button", "date", "color", "time",
])

const BUTTON_TYPES = new Set(["submit", "button", "reset"])

/** id values that could shadow chrome / keyed fragments. */
const FORBIDDEN_ID = /^(ef-|blk-|ws-|ui-)/i

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/

/** Chrome-reserved CLASS names — shell structure agent content must not
 *  hijack. An explicit set (not an ef- prefix ban) because the agent-facing
 *  kit classes share the prefix. */
const FORBIDDEN_CLASS = new Set([
  "ef-shell", "ef-main", "ef-stage", "ef-stage-empty", "ef-stage-empty-mark",
  "ef-stage-empty-lede", "ef-stage-empty-hints", "ef-pages", "ef-page",
  "ef-page-body", "ef-page-dropped", "ef-tabs", "ef-tab", "ef-canvas",
  "ef-chat", "ef-chat-drawer", "ef-refs-drawer", "ef-drawer", "ef-drawer--left",
  "ef-drawer--right", "ef-drawer--open", "ef-drawer-head", "ef-drawer-title",
  "ef-drawer-close", "ef-dock", "ef-composer", "ef-cmdbar", "ef-cmdbar-input",
  "ef-cmdbar-toggle", "ef-header", "ef-header-right", "ef-header-btn",
  "ef-header-title", "ef-header-model", "ef-header-agents", "ef-wordmark",
  "ef-activity", "ef-reply", "ef-queue", "ef-approval", "ef-conn",
  "ef-conn-wait", "ef-rail", "ef-ws-items", "ef-plan", "ef-theme-pick",
  "ef-count-badge", "ef-unread-dot", "ef-ref-flash",
])

const SAFE_HREF = /^(https?:\/\/|\/|#|mailto:)/i
const SAFE_SRC = /^(https:\/\/|\/)/i
const EXTERNAL = /^https?:\/\//i

const ATTR_RE = /([a-zA-Z_][a-zA-Z0-9_:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

/* ------------------------------------------------------------------ */
/* Attributes                                                          */
/* ------------------------------------------------------------------ */

interface AttrState {
  readonly out: string
  readonly dropped: ReadonlyArray<string>
  readonly externalLink: boolean
}

interface AttrVerdict {
  readonly keep: boolean
  readonly outValue: string
  readonly note?: string
  readonly external?: boolean
}

const judgeAttr = (tag: string, name: string, value: string): AttrVerdict => {
  if (name === "id") {
    const ok = SAFE_ID.test(value) && !FORBIDDEN_ID.test(value)
    return { keep: ok, outValue: value, ...(ok ? {} : { note: `${tag}[id=${value}]` }) }
  }
  if (name === "class") {
    const tokens = value.split(/\s+/).filter((c) => c.length > 0)
    const safe = tokens.filter((c) => !FORBIDDEN_CLASS.has(c))
    return {
      keep: safe.length > 0,
      outValue: safe.join(" "),
      ...(safe.length !== tokens.length ? { note: `${tag}[class:chrome]` } : {}),
    }
  }
  if (name === "type") {
    const ok =
      tag === "input"
        ? INPUT_TYPES.has(value.toLowerCase())
        : tag === "button"
          ? BUTTON_TYPES.has(value.toLowerCase())
          : false
    return { keep: ok, outValue: value, ...(ok ? {} : { note: `${tag}[type=${value}]` }) }
  }
  if (name === "method") {
    return { keep: tag === "form" && /^(get|post|dialog)$/i.test(value), outValue: value }
  }
  if (name === "href") {
    const ok = SAFE_HREF.test(value)
    return {
      keep: ok,
      outValue: value,
      ...(ok ? { external: EXTERNAL.test(value) } : { note: `${tag}[href=${value.slice(0, 40)}]` }),
    }
  }
  if (name === "src") {
    const ok = tag === "img" && SAFE_SRC.test(value)
    return { keep: ok, outValue: value, ...(ok ? {} : { note: `${tag}[src=${value.slice(0, 40)}]` }) }
  }
  if (URL_ACTION_ATTRS.has(name)) {
    const ok = value === "/action" || value.startsWith(ACTION_PREFIX)
    return {
      keep: ok,
      outValue: value,
      ...(ok ? {} : { note: `${tag}[${name}=${value.slice(0, 40)}]` }),
    }
  }
  if (name === "hx-vals") {
    const ok = !/^\s*(js|javascript)\s*:/i.test(value)
    return { keep: ok, outValue: value, ...(ok ? {} : { note: `${tag}[hx-vals]` }) }
  }
  if (name === "hx-target") {
    const ok =
      value === "this" ||
      (/^#[A-Za-z][A-Za-z0-9_-]*$/.test(value) && !FORBIDDEN_ID.test(value.slice(1)))
    return { keep: ok, outValue: value, ...(ok ? {} : { note: `${tag}[hx-target=${value.slice(0, 40)}]` }) }
  }
  if (HTMX_ATTRS.has(name) || name.startsWith("aria-") || name.startsWith("data-") || GLOBAL_ATTRS.has(name)) {
    return { keep: true, outValue: value }
  }
  return { keep: false, outValue: value, note: `${tag}[${name}]` }
}

const sanitizeAttrs = (tag: string, attrText: string): AttrState => {
  const folded = [...attrText.matchAll(ATTR_RE)]
    .filter((m) => (m[0] ?? "").trim() !== "")
    .reduce<AttrState>(
      (st, m) => {
        const rawName = (m[1] ?? "").toLowerCase()
        const value = m[2] ?? m[3] ?? m[4] ?? ""
        // htmx also reads `data-hx-*` / `data-ws-*` — normalize first.
        const name =
          rawName.startsWith("data-hx-") || rawName.startsWith("data-ws-")
            ? rawName.slice(5)
            : rawName

        if (
          name.startsWith("on") ||
          name.startsWith("hx-on") ||
          name === "style" ||
          name === "srcset" ||
          name === "formaction"
        ) {
          return { ...st, dropped: [...st.dropped, `${tag}[${rawName}]`] }
        }
        if (
          name === "ws-send" ||
          name === "ws-connect" ||
          name === "hx-swap-oob" ||
          name === "hx-headers" ||
          name === "hx-ext"
        ) {
          return { ...st, dropped: [...st.dropped, `${tag}[${rawName}]`] }
        }
        // We set target/rel ourselves on external links; agent-provided drop silently.
        if (name === "target" || name === "rel") return st

        const verdict = judgeAttr(tag, name, value)
        return {
          out: verdict.keep ? `${st.out} ${name}="${escapeHtml(verdict.outValue)}"` : st.out,
          dropped: verdict.note !== undefined ? [...st.dropped, verdict.note] : st.dropped,
          externalLink: st.externalLink || (verdict.external ?? false),
        }
      },
      { out: "", dropped: [], externalLink: false },
    )
  return tag === "a" && folded.externalLink
    ? { ...folded, out: `${folded.out} target="_blank" rel="noopener noreferrer"` }
    : folded
}

/* ------------------------------------------------------------------ */
/* The tokenizer state machine                                         */
/* ------------------------------------------------------------------ */

interface OpenTag {
  readonly name: string
  readonly allowed: boolean
}

interface WalkState {
  readonly i: number
  readonly out: string
  readonly stack: ReadonlyArray<OpenTag>
  readonly dropped: ReadonlyArray<string>
}

const TAG_CLOSE_RE = /^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/
const TAG_OPEN_RE = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/

const escText = (text: string): string => text.replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Index AFTER a drop-with-contents element's close (depth-counted for
 *  nestable names, first-close for raw-text names). Its own inner fold. */
const skipDropped = (input: string, from: number, name: string): number => {
  const lower = input.toLowerCase()
  if (RAW_TEXT.has(name)) {
    const close = lower.indexOf(`</${name}`, from)
    if (close === -1) return input.length
    const gt = input.indexOf(">", close)
    return gt === -1 ? input.length : gt + 1
  }
  const end = Effect.runSync(
    Effect.iterate(
      { i: from, depth: 1 },
      {
        while: (st) => st.depth > 0 && st.i < input.length,
        body: (st) =>
          Effect.sync(() => {
            const nextOpen = lower.indexOf(`<${name}`, st.i)
            const nextClose = lower.indexOf(`</${name}`, st.i)
            if (nextClose === -1) return { i: input.length, depth: 0 }
            if (nextOpen !== -1 && nextOpen < nextClose) {
              return { i: nextOpen + name.length + 1, depth: st.depth + 1 }
            }
            const gt = input.indexOf(">", nextClose)
            return { i: gt === -1 ? input.length : gt + 1, depth: st.depth - 1 }
          }),
      },
    ),
  )
  return end.i
}

const step = (src: string, st: WalkState): WalkState => {
  const lt = src.indexOf("<", st.i)
  if (lt === -1) {
    return { ...st, i: src.length, out: st.out + escText(src.slice(st.i)) }
  }
  const out = st.out + escText(src.slice(st.i, lt))
  const rest = src.slice(lt)

  if (rest.startsWith("<!--")) {
    const end = src.indexOf("-->", lt + 4)
    return { ...st, out, i: end === -1 ? src.length : end + 3 }
  }
  if (rest.startsWith("<!") || rest.startsWith("<?")) {
    const end = src.indexOf(">", lt + 1)
    return { ...st, out, i: end === -1 ? src.length : end + 1 }
  }

  const closeMatch = TAG_CLOSE_RE.exec(rest)
  if (closeMatch !== null) {
    const name = (closeMatch[1] ?? "").toLowerCase()
    const i = lt + closeMatch[0].length
    const idx = st.stack.findLastIndex((t) => t.name === name)
    if (idx === -1) return { ...st, out, i } // stray close — dropped
    const closes = st.stack
      .slice(idx)
      .filter((t) => t.allowed)
      .reverse()
      .map((t) => `</${t.name}>`)
      .join("")
    return { ...st, out: out + closes, i, stack: st.stack.slice(0, idx) }
  }

  const openMatch = TAG_OPEN_RE.exec(rest)
  if (openMatch !== null) {
    const name = (openMatch[1] ?? "").toLowerCase()
    const attrText = openMatch[2] ?? ""
    const selfClosed = (openMatch[3] ?? "") === "/"
    const i = lt + openMatch[0].length

    if (DROP_WITH_CONTENTS.has(name)) {
      return {
        ...st,
        out,
        dropped: [...st.dropped, name],
        i: !selfClosed && !VOID_TAGS.has(name) ? skipDropped(src, i, name) : i,
      }
    }
    if (!ALLOWED_TAGS.has(name)) {
      // Unwrap: children keep processing; the tag itself vanishes.
      return {
        ...st,
        out,
        i,
        dropped: st.dropped.includes(name) ? st.dropped : [...st.dropped, name],
        stack:
          !selfClosed && !VOID_TAGS.has(name)
            ? [...st.stack, { name, allowed: false }]
            : st.stack,
      }
    }

    const attrs = sanitizeAttrs(name, attrText)
    const dropped = [...st.dropped, ...attrs.dropped]
    if (VOID_TAGS.has(name)) {
      return { ...st, out: `${out}<${name}${attrs.out} />`, i, dropped }
    }
    if (selfClosed) {
      return { ...st, out: `${out}<${name}${attrs.out}></${name}>`, i, dropped }
    }
    return {
      ...st,
      out: `${out}<${name}${attrs.out}>`,
      i,
      dropped,
      stack: [...st.stack, { name, allowed: true }],
    }
  }

  // A lone `<` that opens nothing — text.
  return { ...st, out: `${out}&lt;`, i: lt + 1 }
}

/** Sanitize agent-authored HTML into a self-contained, allowlisted fragment. */
export const sanitizeHtml = (input: string): SanitizeResult => {
  const truncated = input.length > SANITIZE_MAX_BYTES
  const src = truncated ? input.slice(0, SANITIZE_MAX_BYTES) : input

  const final = Effect.runSync(
    Effect.iterate(
      {
        i: 0,
        out: "",
        stack: [],
        dropped: truncated ? ["(truncated: input over 256KB)"] : [],
      } as WalkState,
      {
        while: (st) => st.i < src.length,
        body: (st) => Effect.sync(() => step(src, st)),
      },
    ),
  )

  // Close anything left open so the fragment can't swallow siblings.
  const closes = [...final.stack]
    .reverse()
    .filter((t) => t.allowed)
    .map((t) => `</${t.name}>`)
    .join("")
  return { html: raw(final.out + closes), dropped: final.dropped }
}

/* ------------------------------------------------------------------ */
/* MathML                                                              */
/* ------------------------------------------------------------------ */

/** Presentation-MathML elements the math surface renders. Deliberately NO
 *  `annotation-xml`/`semantics`/`maction` (the classic mathml XSS vectors) and
 *  no content MathML — equations only. */
const MATHML_TAGS = new Set([
  "math", "mrow", "mi", "mn", "mo", "mtext", "mspace", "ms",
  "mfrac", "msup", "msub", "msubsup", "msqrt", "mroot",
  "munder", "mover", "munderover", "mtable", "mtr", "mtd",
  "mstyle", "mpadded", "mphantom", "mfenced", "menclose",
])

/** Layout/typography attributes only — never id/class/style/href/on*. */
const MATHML_ATTRS = new Set([
  "display", "mathvariant", "mathsize", "displaystyle", "scriptlevel",
  "linethickness", "rowspacing", "columnspacing", "rowalign", "columnalign",
  "columnspan", "rowspan", "open", "close", "separators", "stretchy", "form",
  "accent", "accentunder", "fence", "separator", "movablelimits", "largeop",
  "lspace", "rspace", "depth", "height", "width", "notation", "voffset",
])

const MATHML_MAX_BYTES = 8_192

/** Result of {@link sanitizeMathml}: rejected snippets simply don't display. */
export interface MathmlResult {
  readonly ok: boolean
  readonly html: Html
}

const MATHML_REJECTED: MathmlResult = { ok: false, html: raw("") }

interface MathmlStep {
  readonly i: number
  readonly out: string
  readonly stack: ReadonlyArray<string>
  readonly closedRoot: boolean
}

const mathmlAttrs = (attrText: string): string | undefined => {
  const matches = [...attrText.matchAll(/([a-zA-Z_][a-zA-Z0-9_:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)]
  return matches.reduce<string | undefined>((acc, m) => {
    if (acc === undefined || m[0] === "") return acc
    const attr = (m[1] ?? "").toLowerCase()
    const value = m[2] ?? m[3] ?? m[4] ?? ""
    if (!MATHML_ATTRS.has(attr) || /[<>"']/.test(value)) return undefined
    return `${acc} ${attr}="${value}"`
  }, "")
}

/** One tag/text step of the MathML walk; undefined = reject. */
const mathmlStep = (src: string, st: MathmlStep): MathmlStep | undefined => {
  if (st.closedRoot) return undefined // trailing content after </math>
  const lt = src.indexOf("<", st.i)
  if (lt === -1) {
    return st.stack.length === 0 ? { ...st, i: src.length } : undefined
  }
  const text = src.slice(st.i, lt)
  if (/[<>]/.test(text)) return undefined
  const out =
    st.out + text.replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")

  const rest = src.slice(lt)
  const close = /^<\/([a-zA-Z-]+)\s*>/.exec(rest)
  if (close !== null) {
    const name = (close[1] ?? "").toLowerCase()
    if (st.stack[st.stack.length - 1] !== name) return undefined
    const stack = st.stack.slice(0, -1)
    return {
      i: lt + close[0].length,
      out: `${out}</${name}>`,
      stack,
      closedRoot: stack.length === 0,
    }
  }
  const open = /^<([a-zA-Z-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/.exec(rest)
  if (open === null) return undefined
  const name = (open[1] ?? "").toLowerCase()
  if (!MATHML_TAGS.has(name)) return undefined
  if (st.stack.length === 0 && name !== "math") return undefined
  const attrs = mathmlAttrs(open[2] ?? "")
  if (attrs === undefined) return undefined
  const selfClosed = (open[3] ?? "") === "/"
  return {
    i: lt + open[0].length,
    out: selfClosed ? `${out}<${name}${attrs} />` : `${out}<${name}${attrs}>`,
    stack: selfClosed ? st.stack : [...st.stack, name],
    closedRoot: false,
  }
}

const mathmlWalk = (src: string, st: MathmlStep): MathmlStep | undefined => {
  if (st.i >= src.length) return st
  const next = mathmlStep(src, st)
  return next === undefined ? undefined : mathmlWalk(src, next)
}

/**
 * Strict, REJECTING sanitizer for a model-authored equation snippet: the input
 * must be exactly ONE well-formed `<math>` element whose every tag is
 * presentation MathML and every attribute layout-only — anything else is
 * rejected whole (repairing an equation could change its MATH, which is worse
 * than dropping it; the prompt text always carries the question).
 */
export const sanitizeMathml = (input: string): MathmlResult => {
  const src = input.trim()
  if (src.length === 0 || src.length > MATHML_MAX_BYTES) return MATHML_REJECTED
  if (!/^<math[\s>]/i.test(src)) return MATHML_REJECTED
  const end = mathmlWalk(src, { i: 0, out: "", stack: [], closedRoot: false })
  return end === undefined || end.stack.length !== 0 || !end.closedRoot
    ? MATHML_REJECTED
    : { ok: true, html: raw(end.out) }
}
