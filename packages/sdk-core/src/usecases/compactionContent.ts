/**
 * Structure-aware compression planners for compaction — the content-router
 * idea from chopratejas/compaction's SearchCompressor + LogCompressor, ported
 * to the two shapes our tools actually emit. Pure string functions: detect a
 * shape, select what carries signal, report what was dropped. `compaction.ts`
 * weaves the result into its reversible marker (and a fast-tier digest where
 * one helps). When no shape matches, callers fall back to the blind
 * head+tail clip — these planners only ever *improve* on it, never replace
 * its guarantees.
 *
 * Routing is source-hinted like upstream's ContentRouter: search-shape can
 * come from any tool (the `path:NN:` shape is unmistakable), log-shape is
 * only trusted for `Bash` output — prose from web_fetch or file contents
 * mentioning the word "error" must not get log treatment.
 */

/** One planned structural compression. */
export interface ContentPlan {
  readonly kind: "search" | "log"
  /** The structural selection, rendered (marker appended by the caller). */
  readonly kept: string
  /** Representative omitted text for the fast digest; "" = skip the digest. */
  readonly omitted: string
  /** Domain-terms description of what was dropped, for the marker. */
  readonly summary: string
  /** How the model can retrieve what was dropped. */
  readonly hint: string
}

// ─── search results (grep/ripgrep shape) ────────────────────────────────────

/** `path:NN:` match lines and `path-NN-` context lines (grep -C). */
const SEARCH_LINE = /^(.{1,260}?)[:-](\d+)[:-]/
/** Below this many matched lines, grouping adds nothing over a clip. */
const SEARCH_MIN_MATCHES = 20
/** Share of non-empty lines that must parse as matches. */
const SEARCH_MIN_RATIO = 0.75
const SEARCH_MAX_PER_FILE = 5
const SEARCH_LINE_TEXT_MAX = 240

interface SearchMatch {
  readonly file: string
  readonly lineNo: string
  readonly text: string
}

/**
 * Group grep-shaped output by file: every file stays visible (that's the
 * map the model actually needs), capped at {@link SEARCH_MAX_PER_FILE}
 * matches each, greedy until the char budget. A blind clip of the same
 * output keeps 200 matches from the first file and silently erases the
 * other 211 files; this keeps the shape and drops the bulk.
 */
export const planSearchCompression = (
  text: string,
  maxChars: number,
): ContentPlan | undefined => {
  const lines = text.split("\n")
  const nonEmpty = lines.filter((l) => l.trim().length > 0)
  if (nonEmpty.length < SEARCH_MIN_MATCHES) return undefined

  const matches: SearchMatch[] = []
  for (const line of lines) {
    const m = SEARCH_LINE.exec(line)
    if (m === null) continue
    const file = m[1]!
    // A path has structure; "12:34:56 …" timestamps must not parse as one.
    if (!file.includes("/") && !file.includes(".")) continue
    matches.push({
      file,
      lineNo: m[2]!,
      text: line.slice(m[0].length).slice(0, SEARCH_LINE_TEXT_MAX),
    })
  }
  if (matches.length < SEARCH_MIN_MATCHES) return undefined
  if (matches.length / nonEmpty.length < SEARCH_MIN_RATIO) return undefined

  const byFile = new Map<string, SearchMatch[]>()
  for (const m of matches) {
    const group = byFile.get(m.file)
    if (group === undefined) byFile.set(m.file, [m])
    else group.push(m)
  }

  const budget = Math.floor(maxChars * 0.9)
  const out: string[] = []
  let chars = 0
  let shownMatches = 0
  let shownFiles = 0
  for (const [file, group] of byFile) {
    const picked = group.slice(0, SEARCH_MAX_PER_FILE)
    const header =
      group.length > picked.length
        ? `${file} (${group.length} matches, showing ${picked.length})`
        : `${file} (${group.length} ${group.length === 1 ? "match" : "matches"})`
    const body = picked.map((m) => `  ${m.lineNo}: ${m.text}`)
    const block = [header, ...body].join("\n") + "\n"
    if (chars + block.length > budget && shownFiles > 0) break
    out.push(block)
    chars += block.length
    shownMatches += picked.length
    shownFiles++
  }

  return {
    kind: "search",
    kept: out.join(""),
    omitted: "",
    summary:
      `${matches.length - shownMatches} of ${matches.length} matched lines omitted ` +
      `(${byFile.size} files, ${shownFiles} shown, first ${SEARCH_MAX_PER_FILE} matches each)`,
    hint: "re-run the search narrower — a more specific pattern, a subdirectory, or fewer context lines",
  }
}

// ─── build/test logs (Bash output) ──────────────────────────────────────────

const ERROR_RE =
  /\b(error|err!|fail(ed|ure|ing)?|fatal|exception|panic(ked)?|traceback|assert(ion)?(error| failed)?)\b|✗|✖/i
const WARN_RE = /\bwarn(ing)?\b/i
/** Continuation lines of a stack/trace block. */
const TRACE_RE = /^\s+(at\s+\S|File "|\d+ \||[~^]+\s*$)|^\s*Caused by:|^\s{4,}\S/
const SUMMARY_RE =
  /\b(\d+\s+(passing|passed|failing|failed|errors?|warnings?|tests?|pass|fail|skipped))\b|\b(tests?|suites?|snapshots?):\s|\bexit code\b|\bbuild\s+(failed|succeeded)\b|\bcompil(ation|e)\s+(failed|error)\b/i

const LOG_HEAD_LINES = 10
const LOG_TAIL_LINES = 10
const LOG_MAX_ERROR_BLOCKS = 25
const LOG_TRACE_MAX_LINES = 30
const LOG_MAX_WARNINGS = 15
const LOG_MAX_SUMMARIES = 15
const LOG_GAP_MIN = 3

/**
 * Keep the lines a human debugging the run would read: head (the command
 * banner), every error with its trace block intact (a state machine absorbs
 * indented/`at `/`File "` continuations, so chained tracebacks survive),
 * deduped warnings, test-runner summary lines, and the tail (exit state).
 * Everything else is dropped with inline gap markers, re-emitted in original
 * order. Only trusted for Bash output — gated by the caller.
 */
export const planLogCompression = (
  text: string,
  maxChars: number,
): ContentPlan | undefined => {
  const lines = text.split("\n")
  const n = lines.length
  if (n < LOG_HEAD_LINES + LOG_TAIL_LINES + 10) return undefined

  // Classification pass.
  const errorStarts: number[] = []
  const summaryIdx: number[] = []
  const warnIdx: number[] = []
  for (let i = 0; i < n; i++) {
    const line = lines[i]!
    if (ERROR_RE.test(line)) errorStarts.push(i)
    else if (SUMMARY_RE.test(line)) summaryIdx.push(i)
    else if (WARN_RE.test(line)) warnIdx.push(i)
  }
  if (errorStarts.length === 0 && summaryIdx.length < 2) return undefined

  // Selection — priority order under the char budget: head+tail always,
  // then summaries, then error blocks (in order), then deduped warnings.
  const budget = Math.floor(maxChars * 0.9)
  const selected = new Set<number>()
  let chars = 0
  const tryAdd = (idx: ReadonlyArray<number>): boolean => {
    const fresh = idx.filter((i) => !selected.has(i))
    const cost = fresh.reduce((acc, i) => acc + lines[i]!.length + 1, 0)
    if (chars + cost > budget) return false
    for (const i of fresh) selected.add(i)
    chars += cost
    return true
  }

  tryAdd(Array.from({ length: Math.min(LOG_HEAD_LINES, n) }, (_, i) => i))
  tryAdd(Array.from({ length: Math.min(LOG_TAIL_LINES, n) }, (_, i) => n - 1 - i))
  tryAdd(summaryIdx.slice(0, LOG_MAX_SUMMARIES))

  let blocks = 0
  for (const start of errorStarts) {
    if (blocks >= LOG_MAX_ERROR_BLOCKS) break
    const block: number[] = []
    if (start > 0) block.push(start - 1) // one line of leading context
    block.push(start)
    for (let i = start + 1; i < n && block.length < LOG_TRACE_MAX_LINES; i++) {
      if (!TRACE_RE.test(lines[i]!)) break
      block.push(i)
    }
    if (!tryAdd(block)) break
    blocks++
  }

  const seenWarnings = new Map<string, { first: number; count: number }>()
  for (const i of warnIdx) {
    const key = lines[i]!.trim()
    const seen = seenWarnings.get(key)
    if (seen === undefined) seenWarnings.set(key, { first: i, count: 1 })
    else seen.count++
  }
  const warnRepeats = new Map<number, number>()
  let warns = 0
  for (const { first, count } of seenWarnings.values()) {
    if (warns >= LOG_MAX_WARNINGS) break
    if (!tryAdd([first])) break
    if (count > 1) warnRepeats.set(first, count)
    warns++
  }

  // Render in original order with gap markers; small gaps are cheaper to
  // include verbatim than to mark.
  const ordered = [...selected].sort((a, b) => a - b)
  for (let k = 0; k + 1 < ordered.length; k++) {
    const gap = ordered[k + 1]! - ordered[k]! - 1
    if (gap > 0 && gap < LOG_GAP_MIN) {
      for (let i = ordered[k]! + 1; i < ordered[k + 1]!; i++) selected.add(i)
    }
  }
  const final = [...selected].sort((a, b) => a - b)
  const out: string[] = []
  const omittedParts: string[] = []
  let prev = -1
  for (const i of final) {
    if (i > prev + 1) {
      out.push(`  […${i - prev - 1} lines omitted…]`)
      for (let j = prev + 1; j < i; j++) omittedParts.push(lines[j]!)
    }
    const repeat = warnRepeats.get(i)
    out.push(repeat !== undefined ? `${lines[i]!}  (×${repeat})` : lines[i]!)
    prev = i
  }
  if (prev < n - 1) {
    out.push(`  […${n - 1 - prev} lines omitted…]`)
    for (let j = prev + 1; j < n; j++) omittedParts.push(lines[j]!)
  }
  const omittedCount = n - final.length

  return {
    kind: "log",
    kept: out.join("\n"),
    omitted: omittedParts.join("\n"),
    summary:
      `${omittedCount} of ${n} log lines omitted ` +
      `(kept: head/tail, ${blocks} error block${blocks === 1 ? "" : "s"}, warnings, summaries)`,
    hint: "re-run the command piped through grep/head/tail to see an omitted region",
  }
}

/**
 * Route a string to the best structural planner — search-shape from any
 * tool, log-shape only for Bash. `undefined` = no shape matched; use the
 * blind clip.
 */
export const planContentCompression = (
  text: string,
  toolName: string,
  maxChars: number,
): ContentPlan | undefined =>
  planSearchCompression(text, maxChars) ??
  (toolName === "Bash" ? planLogCompression(text, maxChars) : undefined)
