/**
 * Allowlist sanitizer for agent-authored (`render_ui`) HTML — the security
 * boundary between model output and the browser DOM. Single-pass tolerant
 * tokenizer (no DOM, no deps). Everything not explicitly allowed is dropped:
 *
 * - drop WITH contents: script/style/iframe/object/embed/link/meta/base/
 *   svg/math/template/noscript
 * - unknown-but-benign tags are unwrapped (children kept, tag dropped)
 * - `on*`, `hx-on*`, `style`, `srcset`, `formaction` attributes stripped
 * - `href` https/relative only (external links get noopener+_blank);
 *   `src` https/relative; `hx-get`/`hx-post`/`action` must target `/action/…`
 * - `id`s may not spoof our chrome (`ef-`/`blk-`/`ws-`/`ui-` prefixes)
 * - output tags are re-balanced (stray closes dropped, unclosed tags closed)
 *   so a fragment can never swallow siblings outside its card
 *
 * The systemic backstop lives in assets/app.js (htmx `allowEval=false`,
 * `allowScriptTags=false`, `selfRequestsOnly=true`).
 */
import { escapeHtml, raw, type Html } from "./html.js"

export interface SanitizeResult {
  readonly html: Html
  /** What was removed — tag names, attribute names, or `attr=value` notes. */
  readonly dropped: ReadonlyArray<string>
}

export const SANITIZE_MAX_BYTES = 262_144

/** Elements whose entire content is discarded. */
const DROP_WITH_CONTENTS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "svg",
  "math",
  "template",
  "noscript",
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
  "form", "input", "button", "select", "option", "optgroup", "textarea", "label", "fieldset", "legend",
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
const HTMX_ATTRS = new Set(["hx-get", "hx-post", "hx-vals", "hx-target", "hx-swap", "hx-include", "hx-trigger", "hx-indicator"])

const URL_ACTION_ATTRS = new Set(["hx-get", "hx-post", "action"])

const INPUT_TYPES = new Set(["text", "number", "hidden", "radio", "checkbox", "range", "email", "submit", "button", "date", "color", "time"])

const BUTTON_TYPES = new Set(["submit", "button", "reset"])

/** id values that could shadow our chrome / keyed fragments. */
const FORBIDDEN_ID = /^(ef-|blk-|ws-|ui-)/i

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/

/**
 * Chrome-reserved CLASS names — structural/positioned classes that belong to
 * the app shell (page sections, drawers, dock, header, composer, tabs…). Agent
 * page content must not re-use them or it hijacks the layout (found live: a
 * model wrapped its page in `class="ef-page"`, which the shell hides with
 * `display:none`). These exact tokens are stripped from agent HTML; the ef-*
 * KIT classes (ef-card/ef-band/ef-split/ef-hero/ef-section/ef-stat/…) pass
 * through untouched. Kept as an explicit set (not an ef- prefix ban) precisely
 * because the kit shares the prefix.
 */
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

interface OpenTag {
  readonly emitted: string
  readonly name: string
  readonly selfClosed: boolean
  readonly allowed: boolean
}

const sanitizeAttrs = (
  tag: string,
  attrText: string,
  dropped: string[],
): string => {
  let out = ""
  let isExternalLink = false
  ATTR_RE.lastIndex = 0
  for (let m = ATTR_RE.exec(attrText); m !== null; m = ATTR_RE.exec(attrText)) {
    if ((m[0] ?? "").trim() === "") break
    const rawName = (m[1] ?? "").toLowerCase()
    const value = m[2] ?? m[3] ?? m[4] ?? ""
    // htmx also reads `data-hx-*` / `data-ws-*` — normalize before the rules.
    const name = rawName.startsWith("data-hx-") || rawName.startsWith("data-ws-")
      ? rawName.slice(5)
      : rawName

    if (name.startsWith("on") || name.startsWith("hx-on") || name === "style" || name === "srcset" || name === "formaction") {
      dropped.push(`${tag}[${rawName}]`)
      continue
    }
    if (name === "ws-send" || name === "ws-connect" || name === "hx-swap-oob" || name === "hx-headers" || name === "hx-ext") {
      dropped.push(`${tag}[${rawName}]`)
      continue
    }

    let keep = false
    let outValue = value
    if (name === "id") {
      keep = SAFE_ID.test(value) && !FORBIDDEN_ID.test(value)
      if (!keep) dropped.push(`${tag}[id=${value}]`)
    } else if (name === "class") {
      // Keep every token except chrome-reserved ones (which would hijack the
      // shell layout). Empty result → drop the attribute entirely.
      const tokens = value.split(/\s+/).filter((c) => c.length > 0)
      const safe = tokens.filter((c) => !FORBIDDEN_CLASS.has(c))
      keep = safe.length > 0
      outValue = safe.join(" ")
      if (safe.length !== tokens.length) dropped.push(`${tag}[class:chrome]`)
    } else if (name === "type") {
      keep = tag === "input" ? INPUT_TYPES.has(value.toLowerCase()) : tag === "button" ? BUTTON_TYPES.has(value.toLowerCase()) : false
      if (!keep) dropped.push(`${tag}[type=${value}]`)
    } else if (name === "method") {
      keep = tag === "form" && /^(get|post|dialog)$/i.test(value)
    } else if (name === "href") {
      keep = SAFE_HREF.test(value)
      if (keep) isExternalLink = EXTERNAL.test(value)
      else dropped.push(`${tag}[href=${value.slice(0, 40)}]`)
    } else if (name === "src") {
      keep = tag === "img" && SAFE_SRC.test(value)
      if (!keep) dropped.push(`${tag}[src=${value.slice(0, 40)}]`)
    } else if (URL_ACTION_ATTRS.has(name)) {
      keep = value === "/action" || value.startsWith("/action/")
      if (!keep) dropped.push(`${tag}[${name}=${value.slice(0, 40)}]`)
    } else if (name === "hx-vals") {
      keep = !/^\s*(js|javascript)\s*:/i.test(value)
      if (!keep) dropped.push(`${tag}[hx-vals]`)
    } else if (name === "hx-target") {
      keep =
        value === "this" ||
        (/^#[A-Za-z][A-Za-z0-9_-]*$/.test(value) && !FORBIDDEN_ID.test(value.slice(1)))
      if (!keep) dropped.push(`${tag}[hx-target=${value.slice(0, 40)}]`)
    } else if (name === "target" || name === "rel") {
      // We set these ourselves on external links; agent-provided ones drop.
      continue
    } else if (HTMX_ATTRS.has(name)) {
      keep = true
    } else if (name.startsWith("aria-")) {
      keep = true
    } else if (name.startsWith("data-")) {
      keep = true
    } else if (GLOBAL_ATTRS.has(name)) {
      keep = true
    } else {
      dropped.push(`${tag}[${rawName}]`)
    }

    if (keep) out += ` ${name}="${escapeHtml(outValue)}"`
  }
  if (tag === "a" && isExternalLink) out += ` target="_blank" rel="noopener noreferrer"`
  return out
}

/** Skip past a drop-with-contents element. Returns the index AFTER its close. */
const skipDropped = (input: string, from: number, name: string): number => {
  const lower = input.toLowerCase()
  if (RAW_TEXT.has(name)) {
    const close = lower.indexOf(`</${name}`, from)
    if (close === -1) return input.length
    const gt = input.indexOf(">", close)
    return gt === -1 ? input.length : gt + 1
  }
  // Nestable: depth-count same-name open/close tags.
  let depth = 1
  let i = from
  while (i < input.length && depth > 0) {
    const nextOpen = lower.indexOf(`<${name}`, i)
    const nextClose = lower.indexOf(`</${name}`, i)
    if (nextClose === -1) return input.length
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++
      i = nextOpen + name.length + 1
    } else {
      depth--
      const gt = input.indexOf(">", nextClose)
      if (gt === -1) return input.length
      i = gt + 1
    }
  }
  return i
}

const TAG_CLOSE_RE = /^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/
const TAG_OPEN_RE = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/

/** Sanitize agent-authored HTML into a self-contained, allowlisted fragment. */
export const sanitizeHtml = (input: string): SanitizeResult => {
  const dropped: string[] = []
  let src = input
  if (src.length > SANITIZE_MAX_BYTES) {
    src = src.slice(0, SANITIZE_MAX_BYTES)
    dropped.push("(truncated: input over 256KB)")
  }

  let out = ""
  const stack: OpenTag[] = []
  let i = 0
  const emitText = (text: string): void => {
    if (text !== "") out += text.replace(/</g, "&lt;").replace(/>/g, "&gt;")
  }

  while (i < src.length) {
    const lt = src.indexOf("<", i)
    if (lt === -1) {
      emitText(src.slice(i))
      break
    }
    emitText(src.slice(i, lt))
    const restFrom = src.slice(lt)

    if (restFrom.startsWith("<!--")) {
      const end = src.indexOf("-->", lt + 4)
      i = end === -1 ? src.length : end + 3
      continue
    }
    if (restFrom.startsWith("<!") || restFrom.startsWith("<?")) {
      const end = src.indexOf(">", lt + 1)
      i = end === -1 ? src.length : end + 1
      continue
    }

    const closeMatch = TAG_CLOSE_RE.exec(restFrom)
    if (closeMatch !== null) {
      const name = (closeMatch[1] ?? "").toLowerCase()
      i = lt + closeMatch[0].length
      // Pop to the matching open; a stray close (nothing open) is dropped.
      const idx = stack.findLastIndex((t) => t.name === name)
      if (idx !== -1) {
        while (stack.length > idx) {
          const top = stack.pop()
          if (top !== undefined && top.allowed) out += `</${top.name}>`
        }
      }
      continue
    }

    const openMatch = TAG_OPEN_RE.exec(restFrom)
    if (openMatch !== null) {
      const name = (openMatch[1] ?? "").toLowerCase()
      const attrText = openMatch[2] ?? ""
      const selfClosed = (openMatch[3] ?? "") === "/"
      i = lt + openMatch[0].length

      if (DROP_WITH_CONTENTS.has(name)) {
        dropped.push(name)
        if (!selfClosed && !VOID_TAGS.has(name)) i = skipDropped(src, i, name)
        continue
      }
      if (!ALLOWED_TAGS.has(name)) {
        // Unwrap: children continue to be processed; the tag itself vanishes.
        if (!dropped.includes(name)) dropped.push(name)
        if (!selfClosed && !VOID_TAGS.has(name)) stack.push({ emitted: "", name, selfClosed: false, allowed: false })
        continue
      }

      const attrs = sanitizeAttrs(name, attrText, dropped)
      if (VOID_TAGS.has(name)) {
        out += `<${name}${attrs} />`
      } else if (selfClosed) {
        out += `<${name}${attrs}></${name}>`
      } else {
        out += `<${name}${attrs}>`
        stack.push({ emitted: name, name, selfClosed: false, allowed: true })
      }
      continue
    }

    // A lone `<` that opens nothing — text.
    emitText("<")
    i = lt + 1
  }

  // Close anything left open so the fragment can't swallow siblings.
  while (stack.length > 0) {
    const top = stack.pop()
    if (top !== undefined && top.allowed) out += `</${top.name}>`
  }

  return { html: raw(out), dropped }
}
