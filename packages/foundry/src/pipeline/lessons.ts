import { Array as Arr, Option, Order } from "effect"
import type { FactoryRun } from "../domain/FactoryRun.js"

/**
 * The harness doctrine's MEMORY component, done deterministically: pure code
 * derives lessons from the persisted `FactoryRun` history — the recurring
 * reasons the gates have rejected work in this workspace — and drivers fold
 * them into the NEXT run's context (the refiner's prompt, the first-attempt
 * brief). No LLM writes memory; the gate evidence IS the memory, and this
 * fold is its deterministic read. (The old line's LLM-distiller was excised
 * as the advisory anti-pattern; this is its replacement.)
 */

export interface Lesson {
  /** The gate rule that keeps rejecting work. */
  readonly rule: string
  /** Attempts this rule failed, across all runs. */
  readonly failedAttempts: number
  /** Distinct runs it appeared in. */
  readonly runs: number
  /** The most recent example finding message (bounded). */
  readonly lastMessage: string
  /** The most recent fix hint, when a gate offered one. */
  readonly lastFixHint: Option.Option<string>
}

export interface LessonOptions {
  /** A rule becomes a lesson once it has failed this many attempts. */
  readonly minAttempts?: number
  /** At most this many lessons, most-recurrent first. */
  readonly max?: number
}

const DEFAULT_MIN_ATTEMPTS = 2
const DEFAULT_MAX_LESSONS = 5
const MESSAGE_CAP = 200

interface Tally {
  readonly failedAttempts: number
  readonly runIds: Set<string>
  readonly lastMessage: string
  readonly lastFixHint: Option.Option<string>
}

const byRecurrence: Order.Order<Lesson> = Order.combineAll([
  Order.mapInput(Order.flip(Order.Number), (l: Lesson) => l.failedAttempts),
  Order.mapInput(Order.String, (l: Lesson) => l.rule),
])

/**
 * Fold the run history into lessons. Runs are processed oldest-first (by
 * `endedAt`) so "last" fields carry the most recent example. Within one
 * attempt a rule counts ONCE no matter how many findings it produced —
 * the unit of recurrence is "an attempt bounced on this rule".
 */
export const deriveLessons = (
  runs: ReadonlyArray<FactoryRun>,
  options: LessonOptions = {},
): ReadonlyArray<Lesson> => {
  const minAttempts = options.minAttempts ?? DEFAULT_MIN_ATTEMPTS
  const max = options.max ?? DEFAULT_MAX_LESSONS
  const ordered = Arr.sort(
    runs,
    Order.mapInput(Order.Number, (run: FactoryRun) => run.endedAt),
  )
  const tallies = new Map<string, Tally>()
  for (const run of ordered) for (const attempt of run.attempts) {
    const latestByRule = new Map<string, import("../domain/Finding.js").Finding>()
    for (const verdict of attempt.report.failures) for (const finding of verdict.findings) latestByRule.set(String(finding.rule), finding)
    for (const [rule, latest] of latestByRule) {
      const previous = tallies.get(rule)
      const runIds = previous?.runIds ?? new Set<string>()
      runIds.add(String(run.id))
      tallies.set(rule, { failedAttempts: (previous?.failedAttempts ?? 0) + 1, runIds,
        lastMessage: latest.message.slice(0, MESSAGE_CAP), lastFixHint: latest.fixHint })
    }
  }

  const lessons = [...tallies]
    .map(
      ([rule, tally]): Lesson => ({
        rule,
        failedAttempts: tally.failedAttempts,
        runs: tally.runIds.size,
        lastMessage: tally.lastMessage,
        lastFixHint: tally.lastFixHint,
      }),
    )
    .filter((lesson) => lesson.failedAttempts >= minAttempts)
  return Arr.sort(lessons, byRecurrence).slice(0, max)
}

/**
 * The model-facing section — deterministic (stable order, bounded), the
 * `renderFeedback` discipline. Empty lessons render an empty string so
 * callers can splice unconditionally.
 */
export const renderLessons = (lessons: ReadonlyArray<Lesson>): string =>
  lessons.length === 0
    ? ""
    : [
        "## Lessons from past forge runs in this workspace",
        "The deterministic gates have REPEATEDLY rejected work here for these reasons — get them right the FIRST time:",
        ...lessons.map((lesson) => {
          const fix = Option.match(lesson.lastFixHint, {
            onNone: () => "",
            onSome: (hint) => ` Fix: ${hint}`,
          })
          // A spec check that keeps recurring across RUNS is bigger than any
          // one spec — the deterministic hint that it belongs in the standing
          // profile (the flywheel's enforcement arrow, human-armed).
          const promote =
            lesson.rule.startsWith("test/accept-") && lesson.runs >= 2
              ? " (recurring spec check — consider promoting it to a standing check in foundry.config.ts)"
              : ""
          return `- [${lesson.rule}] failed ${lesson.failedAttempts} attempt(s) across ${lesson.runs} run(s) — e.g. ${lesson.lastMessage}${fix}${promote}`
        }),
      ].join("\n")
