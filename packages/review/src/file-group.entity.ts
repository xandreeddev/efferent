import { Schema } from "effect"
import { TurnNumber } from "./finding.entity.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const AtLeastOne = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/** A group's number in a review, from 1, in the order the groups are reviewed. */
export const GroupNumber = AtLeastOne.pipe(Schema.brand("GroupNumber"))
export type GroupNumber = typeof GroupNumber.Type

/**
 * Changed files reviewed together by one focused turn: its number, the package they belong to (the nearest folder
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

/**
 * The most model calls (steps) one focused turn makes by default: a guard against a turn that never ends, the find
 * stage's ledger being the real limit. Measured on four gold groups (2026-11-20): at 8 every turn hit the cap; at 24 every turn
 * ended on its own, after 5 to 17 calls (an interactive reviewer on a stronger model took 8 to 18 turns a review).
 */
export const DEFAULT_GROUP_STEPS = 24

/**
 * The bytes a request holds beside its prompt's text, for the first call's hold a group must have room for: the six
 * tools' declarations and the request's own fields (the declarations are about 6 KB).
 */
export const REQUEST_SLACK_BYTES = 8_000

/**
 * What a model call is held at, for sizing a group's first call before it is sent: the price of input and output per
 * million tokens, the output cap of a call, and how many bytes of a request count as a token (the ledger's own).
 */
export const CallPrice = Schema.Struct({
  input: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  output: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  maxOutputTokens: AtLeastOne,
  bytesPerToken: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type CallPrice = typeof CallPrice.Type

/**
 * What a focused turn keeps back for its closing call by default, in USD: a focused request's hold with room to spare
 * (#644's gold group's seventh call asked to hold $0.040, a request of about 118 KB at 1 byte a token), less than a
 * whole review's `DEFAULT_CLOSING_RESERVE`, sized for 300 KB requests. On #644 the defect was reported on the closing
 * call, after the stage refused the seventh. Raised from $0.05 for the 24-call guard: a turn that reads files whole
 * grows its request, and #644's ninth turn asked to hold $0.077 late in its run, which $0.05 could not close on.
 */
export const DEFAULT_GROUP_RESERVE = 0.1

/** Why a group was not reviewed, in words. */
export const NOT_REVIEWED_BECAUSE = {
  spent: "the find stage had no room for its first call and its closing reserve",
  noCall: "its turn ended before any model call answered",
  stopped: "the find stage refused an earlier group's turn before any of its calls answered, so it stopped",
} as const

/** The note when a focused review found no file to group (config, CI or docs alone) and reviewed the whole pull request. */
export const NO_GROUP_NOTE = "No changed file is code a group holds, so the pull request was reviewed whole (--focus whole)."

/**
 * The order a focused review runs its groups in: by risk (`riskOf`: changed lines on shared state, concurrency,
 * processes, files, the network and secrets first), or in git's order (`git`).
 */
export const GroupOrder = Schema.Literals(["risk", "git"])
export type GroupOrder = typeof GroupOrder.Type

/** A changed file a focused review gives no turn, and why, in words. */
export const UngroupedFile = Schema.Struct({ path: Schema.String, why: Schema.String })
export type UngroupedFile = typeof UngroupedFile.Type

/**
 * How a review's finder turns read the pull request: each walking the whole of it (`whole`), or one focused turn per group of
 * changed source and test files (`groups`).
 */
export const Focus = Schema.Literals(["whole", "groups"])
export type Focus = typeof Focus.Type

/**
 * How a review reads the pull request by default: in focused groups. Measured on the gold cases (2026-11-20, one run
 * each, the gold groups alone): the gold group of #644 found and confirmed its defect ($0.035), which the
 * whole-pull-request turn had missed; #480, #595 and #657's groups missed theirs. A focused review is cut short on a
 * large pull request: at about $0.022 to $0.053 a group (a 24-call guard and the harvest call), the stock find stage
 * ($0.50) reviews about ten to twelve groups and lists the rest as not reviewed.
 */
export const DEFAULT_FOCUS: Focus = "groups"

/**
 * A group as the review ran it: the group, the turn that ran on it (none when none started), why it was not
 * reviewed (`NOT_REVIEWED_BECAUSE`; empty when its turn answered at least one call), and the paths of the skills its
 * message showed (`groupSkills`; none when skills are off or none is called for).
 */
export const GroupRun = Schema.Struct({
  group: FileGroup,
  turn: Schema.OptionFromNullOr(TurnNumber),
  notReviewed: Schema.String,
  skills: Schema.Array(Schema.String),
})
export type GroupRun = typeof GroupRun.Type
