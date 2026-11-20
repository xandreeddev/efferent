import { Schema } from "effect"
import { PassNumber } from "./finding.entity.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const AtLeastOne = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** A group's number in a review, from 1, in the order the groups are reviewed. */
export const GroupNumber = AtLeastOne.pipe(Schema.brand("GroupNumber"))
export type GroupNumber = typeof GroupNumber.Type

/**
 * Changed files reviewed together by one focused pass: its number, the package they belong to (the nearest folder
 * holding a `package.json`, `.` for the repository's root), their paths in the order they are shown, and the estimated
 * tokens of their diffs.
 */
export const FileGroup = Schema.Struct({
  number: GroupNumber,
  package: Schema.String,
  paths: Schema.Array(Schema.String),
  tokens: Count,
})
export type FileGroup = typeof FileGroup.Type

/** How large a group may grow: its diffs' estimated tokens and its files. One file over either is a group alone. */
export const GroupBounds = Schema.Struct({ tokens: AtLeastOne, files: AtLeastOne })
export type GroupBounds = typeof GroupBounds.Type

/**
 * The stock bounds: 6,000 tokens of diff and 8 files. On #644 the 6-file, 49 KB directory group found the defect at its
 * 12th call of 16; the gold file's diff alone found it within 8.
 */
export const DEFAULT_GROUP_BOUNDS: GroupBounds = { tokens: 6_000, files: 8 }

/** The most model calls one focused pass makes by default. */
export const DEFAULT_GROUP_STEPS = 8

/**
 * One call's hold on a focused request, in USD: what the find stage must have left, neither settled nor held, beside a
 * group's closing reserve for its pass to start. Measured on #644's gold group: its seventh call asked to hold $0.040
 * (a request of about 118 KB at 1 byte a token, and 4,096 tokens of output).
 */
export const GROUP_START_ROOM = 0.04

/**
 * What a focused pass keeps back for its closing call by default, in USD: a focused request's hold with room to spare
 * (`GROUP_START_ROOM`), less than a whole review's `DEFAULT_CLOSING_RESERVE`, sized for 300 KB requests. On #644 the
 * defect was reported on the closing call, after the stage refused the seventh.
 */
export const DEFAULT_GROUP_RESERVE = 0.05

/** Why a group was not reviewed, in words. */
export const NOT_REVIEWED_BECAUSE = {
  spent: "the find stage's budget had no room for another pass",
} as const

/**
 * How a review's passes read the pull request: each walking the whole of it (`whole`), or one focused pass per group of
 * changed source and test files (`groups`).
 */
export const Focus = Schema.Literals(["whole", "groups"])
export type Focus = typeof Focus.Type

/**
 * How a review reads the pull request by default: in focused groups. Measured on the gold cases (2026-11-20, one run
 * each, the gold groups alone): the gold group of #644 found and confirmed its defect ($0.035), which the
 * whole-pull-request pass had missed; #480, #595 and #657's groups missed theirs. A focused review is cut short on a
 * large pull request: at about $0.02 to $0.035 a group, the stock find stage ($0.30) reviews about seven groups and
 * lists the rest as not reviewed.
 */
export const DEFAULT_FOCUS: Focus = "groups"

/**
 * A group as the review ran it: the group, and the pass that reviewed it, or none, with why it was not reviewed (the
 * find stage's budget spent).
 */
export const GroupRun = Schema.Struct({
  group: FileGroup,
  pass: Schema.OptionFromNullOr(PassNumber),
  notReviewed: Schema.String,
})
export type GroupRun = typeof GroupRun.Type
