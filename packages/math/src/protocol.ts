import { Option } from "effect"

/**
 * The math driver ↔ agent message contract — format AND parse in one module,
 * so the live sends and the replay reconstruction can never drift. Replaces
 * the web canvas's `[ui:…]` convention on this surface: the student never
 * chats; the server composes machine-formatted requests from typed actions,
 * prefixed with a `[progress]` line summarizing graded results since the
 * agent's last turn (how the tutor adapts without a turn per answer).
 */

export type ProgressResult = "correct" | "wrong" | "revealed" | "reported"

export interface ProgressEntry {
  readonly ex: string
  readonly result: ProgressResult
  readonly attempts: number
  /** `reported` only: what the student answered / what the key claimed. */
  readonly student?: string
  readonly key?: string
  /** `wrong` only: the student moved on without solving it. */
  readonly gaveUp?: boolean
}

export type MathAction =
  | { readonly kind: "start"; readonly grade?: number; readonly theme?: string }
  | { readonly kind: "topic"; readonly grade?: number; readonly theme?: string }
  | { readonly kind: "more" }
  | { readonly kind: "harder" }
  | { readonly kind: "easier" }

const scopeSuffix = (grade: number | undefined, theme: string | undefined): string =>
  `${grade !== undefined ? ` grade=${grade}` : ""}${theme !== undefined && theme !== "" ? ` theme=${JSON.stringify(theme)}` : ""}`

export const formatAction = (action: MathAction): string => {
  switch (action.kind) {
    case "start":
      return `[action] start${scopeSuffix(action.grade, action.theme)}`
    case "topic":
      return `[action] topic${scopeSuffix(action.grade, action.theme)}`
    case "more":
    case "harder":
    case "easier":
      return `[action] ${action.kind}`
  }
}

export const formatProgress = (entries: ReadonlyArray<ProgressEntry>): string =>
  entries.length === 0
    ? ""
    : `[progress] ${entries
        .map(
          (e) =>
            `${e.ex} ${e.result} attempts=${e.attempts}` +
            (e.gaveUp === true ? " gave-up" : "") +
            (e.student !== undefined ? ` student=${JSON.stringify(e.student)}` : "") +
            (e.key !== undefined ? ` key=${JSON.stringify(e.key)}` : ""),
        )
        .join(" · ")}`

/** The full agent-bound message: progress (when any) above the action. */
export const composeAgentMessage = (
  progress: ReadonlyArray<ProgressEntry>,
  action: MathAction,
): string => {
  const p = formatProgress(progress)
  return p === "" ? formatAction(action) : `${p}\n${formatAction(action)}`
}

// ---------------------------------------------------------------------------
// Parsing — replay reads persisted user messages back through this.
// ---------------------------------------------------------------------------

export interface ParsedAgentBound {
  readonly progress: ReadonlyArray<ProgressEntry>
  readonly action?: MathAction
}

const unquote = (raw: string): string => {
  // The quoted strings the formatter emits are JSON strings; anything else
  // (hand-typed, truncated) stays verbatim. A throwing JSON.parse is absence,
  // not an error — decode without try/catch via a validating regex first.
  if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) return raw
  const v = JSON.parse(raw) as unknown
  return typeof v === "string" ? v : raw
}

const ACTION_RE = /^\[action\] (start|topic|more|harder|easier)((?:\s+\S.*)?)$/
const SCOPE_GRADE_RE = /grade=(\d+)/
const SCOPE_THEME_RE = /theme=("(?:[^"\\]|\\.)*")/
const ENTRY_RE = /^(\S+) (correct|wrong|revealed|reported) attempts=(\d+)( gave-up)?(?: student=("(?:[^"\\]|\\.)*"))?(?: key=("(?:[^"\\]|\\.)*"))?$/

const parseProgressLine = (line: string): ReadonlyArray<ProgressEntry> =>
  line
    .slice("[progress] ".length)
    .split(" · ")
    .flatMap((part) => {
      const m = ENTRY_RE.exec(part.trim())
      return m === null
        ? []
        : [
            {
              ex: m[1] ?? "",
              result: (m[2] ?? "wrong") as ProgressResult,
              attempts: Number(m[3] ?? "0"),
              ...(m[4] !== undefined ? { gaveUp: true } : {}),
              ...(m[5] !== undefined ? { student: unquote(m[5]) } : {}),
              ...(m[6] !== undefined ? { key: unquote(m[6]) } : {}),
            } satisfies ProgressEntry,
          ]
    })

const parseActionLine = (line: string): MathAction | undefined => {
  const am = ACTION_RE.exec(line)
  if (am === null) return undefined
  const kind = am[1] as MathAction["kind"]
  if (kind !== "start" && kind !== "topic") return { kind }
  const rest = am[2] ?? ""
  const g = SCOPE_GRADE_RE.exec(rest)
  const t = SCOPE_THEME_RE.exec(rest)
  return {
    kind,
    ...(g !== null ? { grade: Number(g[1]) } : {}),
    ...(t !== null && t[1] !== undefined ? { theme: unquote(t[1]) } : {}),
  }
}

interface AgentBoundFold {
  readonly progress: ReadonlyArray<ProgressEntry>
  readonly action: MathAction | undefined
  readonly matchedAny: boolean
}

/** Parse a persisted user message. `Option.none` when it isn't ours (a human
 *  message from some other surface — replay just skips it). */
export const parseAgentBoundMessage = (text: string): Option.Option<ParsedAgentBound> => {
  const folded = text
    .split("\n")
    .map((l) => l.trim())
    .reduce<AgentBoundFold>(
      (acc, line) => {
        if (line.startsWith("[progress] ")) {
          return {
            ...acc,
            matchedAny: true,
            progress: [...acc.progress, ...parseProgressLine(line)],
          }
        }
        const action = parseActionLine(line)
        return action === undefined
          ? acc
          : { ...acc, matchedAny: true, action }
      },
      { progress: [], action: undefined, matchedAny: false },
    )
  return folded.matchedAny
    ? Option.some({
        progress: folded.progress,
        ...(folded.action !== undefined ? { action: folded.action } : {}),
      })
    : Option.none()
}
