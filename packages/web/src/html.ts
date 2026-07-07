/**
 * The `html` tagged template — the one way strings become markup in this
 * package. Interpolated values are escaped by default; only an explicit
 * {@link raw} passes through. Everything downstream (markdown, components,
 * the sanitizer's output) returns {@link Html}, so escaping holds by
 * construction and `raw()` appears in exactly two places (see CLAUDE.md).
 */

/** Branded markup — an object (not a string subtype) so a plain string can
 *  never be mistaken for already-safe HTML. */
export interface Html {
  readonly __html: string
}

/** Values the template accepts: strings/numbers escape; `Html` passes through;
 *  `null | undefined | false` elide (enables `${cond && html\`…\`}`); arrays
 *  flatten recursively. */
export type Interp = string | number | Html | null | undefined | false | ReadonlyArray<Interp>

const ESCAPE_RE = /[&<>"']/g
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

/** Escape a plain string for use in HTML text or attribute-value position. */
export const escapeHtml = (s: string): string => s.replace(ESCAPE_RE, (c) => ESCAPES[c] ?? c)

const isHtml = (v: unknown): v is Html =>
  typeof v === "object" && v !== null && typeof (v as { __html?: unknown }).__html === "string"

/** Mark a string as already-safe markup. Sanitizer output + vendored assets ONLY. */
export const raw = (s: string): Html => ({ __html: s })

/** Unwrap `Html` to the final string (the seam to `socket.send` / HTTP bodies). */
export const render = (h: Html): string => h.__html

const interpToString = (v: Interp): string => {
  if (v === null || v === undefined || v === false) return ""
  if (typeof v === "string") return escapeHtml(v)
  if (typeof v === "number") return String(v)
  if (isHtml(v)) return v.__html
  if (Array.isArray(v)) return v.map(interpToString).join("")
  // Anything else (a malformed Html-like object slipped past the types): escape it.
  return escapeHtml(String(v))
}

/** The tagged template. `html\`<p>${text}</p>\`` escapes `text`. */
export const html = (strings: TemplateStringsArray, ...vals: ReadonlyArray<Interp>): Html => {
  let out = strings[0] ?? ""
  for (let i = 0; i < vals.length; i++) {
    out += interpToString(vals[i] as Interp)
    out += strings[i + 1] ?? ""
  }
  return { __html: out }
}

/** Join a list of fragments (default: no separator). */
export const join = (items: ReadonlyArray<Html>, sep?: Html): Html => ({
  __html: items.map((i) => i.__html).join(sep === undefined ? "" : sep.__html),
})

/** The empty fragment. */
export const empty: Html = { __html: "" }
