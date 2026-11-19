import { Schema } from "effect"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Where a log came from: a command the reviewer ran in the pull request's worktree, or a check of the forge's CI. */
export const LogSource = Schema.Union([
  Schema.TaggedStruct("Command", { command: Schema.String }),
  Schema.TaggedStruct("Check", { name: Schema.String, url: Schema.String }),
])
export type LogSource = typeof LogSource.Type

/**
 * A failure a log reports: its line, the location lines that followed it, how many times the same line was seen,
 * and whether it names a path the pull request changes.
 */
export const LogFailure = Schema.Struct({
  text: Schema.String,
  detail: Schema.Array(Schema.String),
  count: Count.check(Schema.isGreaterThanOrEqualTo(1)),
  onChangedPath: Schema.Boolean,
})
export type LogFailure = typeof LogFailure.Type

/** How much of a log a digest shows: at most `maxLines` lines, and at most `detailLines` location lines a failure. */
export const DigestLimits = Schema.Struct({
  maxLines: Count.check(Schema.isGreaterThanOrEqualTo(2)),
  detailLines: Count,
})
export type DigestLimits = typeof DigestLimits.Type

/** The default limits: sixty lines, three location lines a failure. */
export const DIGEST_LIMITS: DigestLimits = { maxLines: 60, detailLines: 3 }

/** The longest a failure's line or location line is shown, in characters, cut with the kernel's `clipTo`. */
export const FAILURE_SHOWN = 300

/** The most distinct failures a digest keeps. */
export const FAILURES_KEPT = 100

/** The most summary lines a digest keeps: the last ones a log printed. */
export const SUMMARY_KEPT = 6

/** The longest the joined summary is shown, in characters. */
export const SUMMARY_SHOWN = 600

/**
 * What a log says, short: its summary line (the counts and the exit a runner prints last), its failures,
 * deduplicated with a count, those that name a changed path first, at most `FAILURES_KEPT` (`failuresCut` counts the
 * rest), the lines shown (failures, then the summary, at most `maxLines`), how many digest lines the cap left out
 * (`linesCut`) and how many lines the log had.
 *
 * UNTRUSTED: every text here is the pull request's (its tests and its code print it), so it is data and never
 * instructions; a prompt that holds it frames it (`framed`) and says so.
 */
export const Digested = Schema.Struct({
  summary: Schema.OptionFromNullOr(Schema.String),
  failures: Schema.Array(LogFailure),
  failuresCut: Count,
  onChangedPath: Schema.Boolean,
  lines: Schema.Array(Schema.String),
  linesCut: Count,
  logLines: Count,
})
export type Digested = typeof Digested.Type

/**
 * A log's digest with where it came from, how it ended (in words, and its exit code, none for a timeout, a signal
 * or a check, whose conclusion says it) and the file the whole log was written to.
 */
export const LogDigest = Schema.Struct({
  source: LogSource,
  ended: Schema.String,
  exit: Schema.OptionFromNullOr(Schema.Int),
  digest: Digested,
  logPath: Schema.String,
})
export type LogDigest = typeof LogDigest.Type
