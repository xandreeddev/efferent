import { ACTION_PREFIX, UI_ID_FIELD } from "./contract.js"
import { sanitizeHtml } from "./sanitize.js"

/**
 * Deterministic UI gates for agent-authored (`render_ui`) HTML — the
 * ui-builder's enforcement layer (docs/agents/ui-builder.md). The SANITIZER
 * stays the security boundary (it silently repairs); `validateUi` is the
 * FEEDBACK boundary: it turns what the sanitizer would silently strip — plus
 * the wiring/a11y/exfiltration failures the sanitizer doesn't own — into
 * typed findings the model must fix. Hard findings reject the whole call
 * (the HtmlTooLarge pattern: model-readable, `failureMode: "return"`).
 *
 * Shares the sanitizer's vocabulary (one tokenizer family, same attribute
 * grammar) so the two can never drift: anything `sanitizeHtml` drops IS a
 * `dangerous-vocabulary` finding here.
 */
export interface UiFinding {
  readonly rule:
    | "dangerous-vocabulary"
    | "hx-wiring"
    | "a11y-min"
    | "no-arbitrary-values"
  readonly detail: string
}

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g
const ATTR_RE = /([a-zA-Z_][a-zA-Z0-9_:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

interface TagToken {
  readonly name: string
  readonly attrs: ReadonlyMap<string, string>
  readonly raw: string
}

const tokenize = (html: string): ReadonlyArray<TagToken> =>
  [...html.matchAll(TAG_RE)].map((m) => {
    const attrs = new Map(
      [...(m[2] ?? "").matchAll(ATTR_RE)]
        .filter((a) => (a[1] ?? "") !== "")
        .map((a) => [
          (a[1] ?? "").toLowerCase().replace(/^data-/, ""),
          a[2] ?? a[3] ?? a[4] ?? "",
        ]),
    )
    return { name: (m[1] ?? "").toLowerCase(), attrs, raw: m[0] ?? "" }
  })

const textBetween = (html: string, openEnd: number, tag: string): string => {
  const close = html.toLowerCase().indexOf(`</${tag}>`, openEnd)
  return close === -1 ? "" : html.slice(openEnd, close)
}

/* ------------------------------------------------------------------ */
/* The four hard gate families                                          */
/* ------------------------------------------------------------------ */

/** 1 · Everything the sanitizer would silently strip is a violation the model
 *  must SEE — a dropped tag/attr means the model reached for banned vocabulary
 *  (script, iframe, svg, on*, style…), and silent repair teaches it nothing. */
const dangerousVocabulary = (html: string): ReadonlyArray<UiFinding> =>
  [...new Set(sanitizeHtml(html).dropped)].map((dropped) => ({
    rule: "dangerous-vocabulary",
    detail: `the sanitizer would strip "${dropped}" — remove it and use the ef-* kit / plain HTML instead`,
  }))

/** 2 · htmx wiring: POSTs only under /action/, hx-target resolves IN this
 *  fragment, and a `/action/ui` form carries the `ui-id` field that routes its
 *  post-back. Broken wiring renders fine and then dies on first click — the
 *  classic "looks done, isn't" failure. */
const hxWiring = (html: string, tokens: ReadonlyArray<TagToken>): ReadonlyArray<UiFinding> => {
  const ids = new Set(
    tokens.flatMap((t) => {
      const id = t.attrs.get("id")
      return id !== undefined && id !== "" ? [id] : []
    }),
  )
  return tokens.flatMap((t) => {
    const findings: Array<UiFinding> = []
    const post = t.attrs.get("hx-post") ?? t.attrs.get("hx-get")
    if (post !== undefined && !post.startsWith(ACTION_PREFIX)) {
      findings.push({
        rule: "hx-wiring",
        detail: `<${t.name}> targets "${post}" — browser requests may only hit ${ACTION_PREFIX}* endpoints`,
      })
    }
    const target = t.attrs.get("hx-target")
    if (target !== undefined && target.startsWith("#") && !ids.has(target.slice(1))) {
      findings.push({
        rule: "hx-wiring",
        detail: `hx-target="${target}" resolves nothing in this fragment — add the element or fix the selector`,
      })
    }
    if (t.name === "form" && (t.attrs.get("hx-post") === "/action/ui" || t.attrs.get("action") === "/action/ui")) {
      const hasUiId = new RegExp(`name=["']?${UI_ID_FIELD}["']?`, "i").test(html)
      if (!hasUiId) {
        findings.push({
          rule: "hx-wiring",
          detail: `a form posting to /action/ui needs a hidden <input name="${UI_ID_FIELD}" value="<page-id>"> so the post-back names its page`,
        })
      }
    }
    return findings
  })
}

/** 3 · The a11y minimum: images carry alt, interactive controls have an
 *  accessible name, form inputs are labelled. Not a full audit — the floor a
 *  generated page must never sink below. */
const a11yMin = (html: string, tokens: ReadonlyArray<TagToken>): ReadonlyArray<UiFinding> => {
  const labelFor = new Set(
    tokens.flatMap((t) => {
      const f = t.name === "label" ? t.attrs.get("for") : undefined
      return f !== undefined && f !== "" ? [f] : []
    }),
  )
  return tokens.flatMap((t, index) => {
    if (t.name === "img" && (t.attrs.get("alt") ?? "") === "" && t.attrs.get("aria-hidden") !== "true") {
      return [{ rule: "a11y-min" as const, detail: `<img src="${(t.attrs.get("src") ?? "").slice(0, 40)}…> needs alt text (or aria-hidden="true" if decorative)` }]
    }
    if (t.name === "button" || t.name === "a") {
      const start = html.indexOf(t.raw)
      const inner = textBetween(html, start + t.raw.length, t.name)
      const named =
        inner.replace(/<[^>]*>/g, "").trim().length > 0 ||
        (t.attrs.get("aria-label") ?? "") !== ""
      return named
        ? []
        : [{ rule: "a11y-min" as const, detail: `<${t.name}> #${index} has no visible text and no aria-label` }]
    }
    if (t.name === "input" || t.name === "select" || t.name === "textarea") {
      const type = (t.attrs.get("type") ?? "").toLowerCase()
      if (type === "hidden" || type === "submit" || type === "button") return []
      const id = t.attrs.get("id") ?? ""
      const named =
        (t.attrs.get("aria-label") ?? "") !== "" ||
        (t.attrs.get("placeholder") ?? "") !== "" ||
        (id !== "" && labelFor.has(id))
      return named
        ? []
        : [{ rule: "a11y-min" as const, detail: `<${t.name} name="${t.attrs.get("name") ?? "?"}"> needs a label, aria-label, or placeholder` }]
    }
    return []
  })
}

/** 4 · No arbitrary-value Tailwind classes: `bg-[url(…)]` is a reopened
 *  exfiltration channel (CSS fetches an attacker URL the moment the page
 *  paints) and `w-[…]`/`text-[…]` escape the design scale. Named utilities
 *  only. */
const noArbitraryValues = (tokens: ReadonlyArray<TagToken>): ReadonlyArray<UiFinding> =>
  tokens.flatMap((t) => {
    const classes = (t.attrs.get("class") ?? "").split(/\s+/).filter((c) => /\[[^\]]*\]/.test(c))
    return classes.map((cls) => ({
      rule: "no-arbitrary-values" as const,
      detail: `class "${cls}" uses an arbitrary value — use named Tailwind utilities (arbitrary url()/values are banned: exfiltration + off-scale styling)`,
    }))
  })

/* ------------------------------------------------------------------ */

/** Run every UI gate over one `render_ui` html payload; empty = pass. */
export const validateUi = (html: string): ReadonlyArray<UiFinding> => {
  const tokens = tokenize(html)
  return [
    ...dangerousVocabulary(html),
    ...hxWiring(html, tokens),
    ...a11yMin(html, tokens),
    ...noArbitraryValues(tokens),
  ]
}

/** The model-facing feedback brief — deterministic order, one line per finding. */
export const renderUiFindings = (findings: ReadonlyArray<UiFinding>): string =>
  [...findings]
    .sort((a, b) => (a.rule === b.rule ? a.detail.localeCompare(b.detail) : a.rule.localeCompare(b.rule)))
    .map((f) => `[${f.rule}] ${f.detail}`)
    .join("\n")
