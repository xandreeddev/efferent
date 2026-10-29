import { Option, Result } from "effect"

/**
 * Glob patterns over POSIX paths relative to a root, without a file system:
 * `*` and `?` match within one path segment, `**` (a whole segment) matches
 * any number of segments, `[abc]`, `[a-z]` and `[!a]` / `[^a]` match one
 * character, `{a,b}` (nestable) is either alternative, and `\` makes the
 * next character literal. A `[` with no closing `]` is literal, as is a
 * `{...}` with no top-level comma. Leading `./` and empty segments are
 * ignored. A segment matches a name starting with a dot only when `dot` is
 * set or the pattern segment itself starts with a literal dot; `**` never
 * crosses such names without `dot`. A pattern whose braces stand for more
 * than 1024 patterns is refused, never cut short.
 */
export interface GlobMatcher {
  /** Whether this relative path matches the pattern. */
  readonly matches: (path: string) => boolean
  /** Whether the directory at this relative path can hold a match, so a walk should enter it. */
  readonly descends: (dir: string) => boolean
}

export interface GlobMatchOptions {
  readonly dot?: boolean
}

/** At most this many brace alternatives: `{a,b}` twenty times over would be a million patterns. */
const maxAlternatives = 1024

type Segment = { readonly _tag: "Globstar" } | { readonly _tag: "Name"; readonly pattern: RegExp }

/** Characters that mean something to a `u`-mode regular expression outside a class. */
const syntax = new Set(["^", "$", "\\", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|", "/"])
const literal = (char: string): string => syntax.has(char) ? `\\${char}` : char
/** Inside a class only these need escaping; `-` stays a range operator. */
const classLiteral = (char: string): string => char === "\\" || char === "]" || char === "[" || char === "^" ? `\\${char}` : char

interface Brace {
  readonly open: number
  readonly close: number
  readonly commas: ReadonlyArray<number>
}

/** For each character, whether a `\` before it makes it literal. */
const escapedFlags = (chars: ReadonlyArray<string>): ReadonlyArray<boolean> => chars.reduce<{ readonly flags: ReadonlyArray<boolean>; readonly pending: boolean }>(
  (state, char) => ({ flags: [...state.flags, state.pending], pending: !state.pending && char === "\\" }),
  { flags: [], pending: false },
).flags

interface BraceScan {
  readonly depth: number
  readonly commas: ReadonlyArray<number>
  readonly close: Option.Option<number>
}

/** The first `{...}` with a top-level comma, scanning from the left; an unmatched or comma-less brace is literal. */
const firstBrace = (pattern: string): Option.Option<Brace> => {
  const chars = Array.from(pattern)
  const escaped = escapedFlags(chars)
  const special = (index: number, char: string) => chars[index] === char && escaped[index] !== true
  const scanFrom = (start: number): Option.Option<Brace> => {
    const open = chars.findIndex((_, index) => index >= start && special(index, "{"))
    if (open < 0) return Option.none()
    const scan = chars.reduce<BraceScan>((state, _, index) => {
      if (index <= open || Option.isSome(state.close)) return state
      if (special(index, "{")) return { ...state, depth: state.depth + 1 }
      if (special(index, ",") && state.depth === 0) return { ...state, commas: [...state.commas, index] }
      if (!special(index, "}")) return state
      return state.depth > 0 ? { ...state, depth: state.depth - 1 } : { ...state, close: Option.some(index) }
    }, { depth: 0, commas: [], close: Option.none() })
    return Option.match(Option.filter(scan.close, () => scan.commas.length > 0), {
      onNone: () => scanFrom(open + 1),
      onSome: (close) => Option.some({ open, close, commas: scan.commas }),
    })
  }
  return scanFrom(0)
}

/**
 * Every brace-free pattern the braces stand for, in order. The expansion
 * stops one past `maxAlternatives`, so a longer result means too many.
 */
const expandBraces = (pattern: string): ReadonlyArray<string> => Option.match(firstBrace(pattern), {
  onNone: () => [pattern],
  onSome: ({ open, close, commas }) => {
    const chars = Array.from(pattern)
    const bounds = [open, ...commas, close]
    const before = chars.slice(0, open).join("")
    const after = chars.slice(close + 1).join("")
    return bounds.slice(1).map((end, index) => chars.slice((bounds[index] ?? open) + 1, end).join(""))
      .reduce<ReadonlyArray<string>>((all, alternative) => all.length > maxAlternatives ? all
        : [...all, ...expandBraces(`${before}${alternative}${after}`)].slice(0, maxAlternatives + 1), [])
  },
})

interface Member {
  readonly char: string
  readonly escaped: boolean
}

const codePoint = (member: Member | undefined): number => member?.char.codePointAt(0) ?? 0

/**
 * The class at `open` (a `[`) as regular-expression source and the index of
 * its `]`; none when it never closes or a range runs backwards (`[z-a]`),
 * and the `[` is then literal.
 */
const classAt = (chars: ReadonlyArray<string>, open: number): Option.Option<{ readonly source: string; readonly close: number }> => {
  const negated = chars[open + 1] === "!" || chars[open + 1] === "^"
  const first = open + 1 + (negated ? 1 : 0)
  // A `]` right after the opening (and its negation) is a member, not the end.
  const close = chars.findIndex((char, index) => index > first && char === "]" && chars[index - 1] !== "\\")
  if (close < 0) return Option.none()
  const members = chars.slice(first, close).reduce<{ readonly members: ReadonlyArray<Member>; readonly escaping: boolean }>((state, char) =>
    !state.escaping && char === "\\" ? { ...state, escaping: true } : { members: [...state.members, { char, escaped: state.escaping }], escaping: false },
  { members: [], escaping: false }).members
  // An unescaped `-` between two members is a range operator; anywhere else it is itself.
  const isRange = (member: Member, index: number) => !member.escaped && member.char === "-" && index > 0 && index < members.length - 1
  if (members.some((member, index) => isRange(member, index) && codePoint(members[index - 1]) > codePoint(members[index + 1]))) return Option.none()
  const source = members.map((member, index) => isRange(member, index) ? "-" : member.char === "-" ? "\\-" : classLiteral(member.char)).join("")
  return Option.some({ source: `[${negated ? "^" : ""}${source}]`, close })
}

/** One path segment of a pattern as an anchored regular expression. */
const segmentPattern = (segment: string, dot: boolean): RegExp => {
  const chars = Array.from(segment)
  const body = chars.reduce<{ readonly source: string; readonly next: number }>((state, char, index) => {
    if (index < state.next) return state
    if (char === "\\") return { source: state.source + literal(chars[index + 1] ?? "\\"), next: index + 2 }
    if (char === "*") return { source: state.source + "[^/]*", next: index + 1 }
    if (char === "?") return { source: state.source + "[^/]", next: index + 1 }
    if (char === "[") {
      return Option.match(classAt(chars, index), {
        onNone: () => ({ source: state.source + literal(char), next: index + 1 }),
        onSome: (found) => ({ source: state.source + found.source, next: found.close + 1 }),
      })
    }
    return { source: state.source + literal(char), next: index + 1 }
  }, { source: "", next: 0 })
  const explicitDot = chars[0] === "." || (chars[0] === "\\" && chars[1] === ".")
  return new RegExp(`^${dot || explicitDot ? "" : "(?!\\.)"}${body.source}$`, "u")
}

/** A path's segments, without empty and `.` ones. */
const segmentsOf = (path: string): ReadonlyArray<string> => path.split("/").filter((segment) => segment.length > 0 && segment !== ".")

const compileOne = (pattern: string, dot: boolean): ReadonlyArray<Segment> => segmentsOf(pattern)
  .map((segment): Segment => segment === "**" ? { _tag: "Globstar" } : { _tag: "Name", pattern: segmentPattern(segment, dot) })
  // `**/**` is one `**`.
  .filter((segment, index, all) => !(segment._tag === "Globstar" && all[index - 1]?._tag === "Globstar"))

/** Whether `names[from...]` is matched by `pattern[at...]` in full. */
const matchFrom = (pattern: ReadonlyArray<Segment>, at: number, names: ReadonlyArray<string>, from: number, dot: boolean): boolean => {
  const segment = pattern[at]
  if (segment === undefined) return from === names.length
  const name = names[from]
  if (segment._tag === "Globstar") {
    return matchFrom(pattern, at + 1, names, from, dot)
      || (name !== undefined && (dot || !name.startsWith(".")) && matchFrom(pattern, at, names, from + 1, dot))
  }
  return name !== undefined && segment.pattern.test(name) && matchFrom(pattern, at + 1, names, from + 1, dot)
}

/** Whether some path below `names` (a directory) can be matched by `pattern[at...]`. */
const prefixFrom = (pattern: ReadonlyArray<Segment>, at: number, names: ReadonlyArray<string>, from: number, dot: boolean): boolean => {
  const segment = pattern[at]
  if (segment === undefined) return false
  const name = names[from]
  if (name === undefined) return true
  if (segment._tag === "Globstar") {
    return prefixFrom(pattern, at + 1, names, from, dot) || ((dot || !name.startsWith(".")) && prefixFrom(pattern, at, names, from + 1, dot))
  }
  return segment.pattern.test(name) && prefixFrom(pattern, at + 1, names, from + 1, dot)
}

/**
 * Compile a pattern once into a path matcher and the walk's descent test.
 * Fails, with the reason, when the braces stand for more than 1024 patterns
 * or a part does not compile.
 */
export const compileGlob = (pattern: string, options?: GlobMatchOptions): Result.Result<GlobMatcher, string> => {
  const dot = options?.dot ?? false
  const expanded = expandBraces(pattern)
  if (expanded.length > maxAlternatives) return Result.fail(`its braces stand for more than ${maxAlternatives} patterns`)
  const compiled = Result.try({ try: () => expanded.map((one) => compileOne(one, dot)), catch: (cause) => `it does not compile: ${String(cause)}` })
  return Result.map(compiled, (all): GlobMatcher => ({
    matches: (path) => {
      const names = segmentsOf(path)
      return all.some((segments) => matchFrom(segments, 0, names, 0, dot))
    },
    descends: (dir) => {
      const names = segmentsOf(dir)
      return all.some((segments) => prefixFrom(segments, 0, names, 0, dot))
    },
  }))
}

/** Whether a relative POSIX path matches the pattern (see `compileGlob`, and when it fails). */
export const globMatcher = (pattern: string, options?: GlobMatchOptions): Result.Result<(path: string) => boolean, string> =>
  Result.map(compileGlob(pattern, options), (matcher) => matcher.matches)
