import { inspect } from "node:util"

/**
 * Verbose, depth-bounded dump of an error — the FULL nested structure. This is
 * for the log file (`~/.efferent/efferent.log`), never the rail: it can run to
 * dozens of lines and may contain request headers. Was the body of the old
 * `formatFullError`; the rail now gets the compact `formatFullError` below.
 */
export const inspectError = (err: unknown): string =>
  inspect(err, { depth: 10, maxArrayLength: 200, maxStringLength: 100_000, breakLength: 120 })

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null

/** Walk the `.cause` chain (bounded, cycle-safe) into a flat list of nodes. */
const causeChain = (err: unknown): ReadonlyArray<Record<string, unknown>> => {
  const nodes: Array<Record<string, unknown>> = []
  let cur: unknown = err
  const seen = new Set<unknown>()
  while (isObj(cur) && !seen.has(cur) && nodes.length < 12) {
    seen.add(cur)
    nodes.push(cur)
    cur = cur.cause
  }
  return nodes
}

const str = (x: unknown): string | undefined =>
  typeof x === "string" && x.length > 0 ? x : undefined

/**
 * Scrub anything secret-shaped from a string before it reaches the visible UI:
 * bearer tokens, `sk-`/`Bearer` keys, and `authorization`-style header lines.
 * The composed rail message shouldn't contain these, but redact defensively.
 */
const redact = (s: string): string =>
  s
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ‹redacted›")
    .replace(/\bsk-[A-Za-z0-9._-]{6,}/g, "sk-‹redacted›")
    .replace(/("?(?:authorization|x-api-key|api[_-]?key)"?\s*[:=]\s*)("?)[^"\n,}]+/gi, "$1‹redacted›")

const authHint = (provider: string | undefined): string =>
  `→ ${provider !== undefined ? `${provider} ` : ""}credential rejected — run :login to refresh it, or :model to switch provider`

/** Recognised human reason phrases. */
const REASON_RE =
  /(unauthorized|forbidden|not found|rate.?limit|quota|insufficient|invalid[ _-]?api[ _-]?key|invalid[ _-]?request|token[ _-]?revoked|authentication|expired|timed? ?out|overloaded)/i

/**
 * Drop everything inside balanced `{…}` (provider errors embed pretty-printed
 * JSON bodies, often several times), leaving the prose between/around them —
 * the human sentence usually sits BETWEEN two JSON blocks, so a greedy strip
 * would eat it. Whitespace-collapsed per line afterwards.
 */
const stripJson = (s: string): string => {
  let out = ""
  let depth = 0
  for (const ch of s) {
    if (ch === "{") depth++
    else if (ch === "}") {
      if (depth > 0) depth--
      continue
    }
    if (depth === 0) out += ch
  }
  return out
}

/**
 * Render an error into a COMPACT, secret-free, actionable rail message.
 *
 * The previous implementation dumped `inspect(err, {depth:10})` — for a provider
 * HTTP error that's ~75+ lines of nested request/response (leaking the bearer
 * token) which flooded the conversation pane. This walks the `.cause` chain,
 * pulls out the status / error-code / one human sentence, adds a `:login`/`:model`
 * hint for auth failures, and caps the whole thing. Full detail still goes to the
 * log via `inspectError`.
 */
export const formatFullError = (err: unknown): string => {
  if (typeof err === "string") return redact(err).slice(0, 400)

  const nodes = causeChain(err)
  const messages = nodes.map((n) => str(n.message)).filter((m): m is string => m !== undefined)
  const haystack = messages.join("\n")

  // Structured signals — only ever read from real fields / explicit patterns,
  // never by scraping bare numbers out of free text (so a "provider 500"
  // message stays a plain message, not a fake status line).
  let status: number | undefined
  for (const n of nodes) {
    if (typeof n.status === "number") { status = n.status; break }
    const resp = n.response
    if (isObj(resp) && typeof resp.status === "number") { status = resp.status; break }
  }
  if (status === undefined) {
    const m = haystack.match(/"status"\s*:\s*(\d{3})\b/)
    if (m !== undefined && m !== null) status = Number(m[1])
  }

  let code: string | undefined
  for (const n of nodes) {
    const c = str(n.code)
    if (c !== undefined) { code = c; break }
  }
  if (code === undefined) {
    const m = haystack.match(/"code"\s*:\s*"([^"]+)"/)
    if (m !== undefined && m !== null) code = m[1]
  }

  const reasonLine = stripJson(haystack)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0 && REASON_RE.test(l))
  const reason = reasonLine !== undefined ? reasonLine.slice(0, 160) : undefined

  // Provider label from the @effect/ai module on any node (e.g.
  // "OpenAiLanguageModel" → "openai") — tells the user WHICH credential failed.
  const moduleName = nodes
    .map((n) => str(n.module))
    .find((m): m is string => m !== undefined)
  const provider =
    moduleName !== undefined
      ? moduleName.replace(/(LanguageModel|Client|Provider)$/i, "").toLowerCase()
      : undefined

  const hasEmbeddedDump = haystack.includes("{")
  const structured =
    status !== undefined || code !== undefined || reason !== undefined || nodes.length > 1 || hasEmbeddedDump

  // No structured signal → it's an ordinary, already-readable error message.
  if (!structured) {
    const msg = messages[0] ?? String(err)
    return redact(msg).split("\n").slice(0, 3).join("\n").slice(0, 400)
  }

  const tag = status !== undefined || code !== undefined
    ? `(${[status, code].filter((x) => x !== undefined).join(" ")})`
    : undefined
  const head = [
    provider !== undefined ? `${provider} request failed` : "request failed",
    tag,
    reason !== undefined ? `: ${reason}` : undefined,
  ]
    .filter((x) => x !== undefined)
    .join(" ")
    .replace(" :", ":")

  const isAuth =
    status === 401 ||
    status === 403 ||
    (code !== undefined && /revoked|invalid.?api|unauthor|auth/i.test(code)) ||
    (reason !== undefined && /unauthorized|forbidden|invalid api key|token.?revoked|authentication/i.test(reason))

  const lines = [head]
  if (isAuth) lines.push(authHint(provider))
  return redact(lines.join("\n")).slice(0, 480)
}
