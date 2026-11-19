import { Schema } from "effect"
import { FileDiff } from "./diff.entity.js"
import { CheckNumber, PassNumber } from "./finding.entity.js"
import { CommitSha, RepoName } from "./pull-request.entity.js"

/** The tools' names, as the model calls them. */
export const READ_LINES = "readLines"
export const SEARCH_CODE = "searchCode"
export const LIST_FILES = "listFiles"
export const READ_DIFF = "readDiff"
export const REPORT_FINDING = "reportFinding"
export const VERDICT = "verdict"

/**
 * The version of the review's tool set: their names, descriptions, parameters and answers. A change to any of them
 * is a new version, kept with each review's record so results are compared tool set to tool set.
 */
export const REVIEW_TOOLS_VERSION = "review-tools-3"

/** The most lines one `readLines` call reads. */
export const READ_LINES_LIMIT = 150

/** The longest one line `readLines` shows, in characters; the rest is clipped with a count. */
export const LINE_SHOWN = 500

/** The most lines one `searchCode` call answers. */
export const SEARCH_LIMIT = 50

/** The longest one line `searchCode` shows, its path and number included, in characters. */
export const SEARCH_LINE_SHOWN = 200

/** The longest pattern `searchCode` takes, in characters. */
export const PATTERN_LIMIT = 300

/** The most paths one `listFiles` call answers. */
export const LIST_LIMIT = 200

/** The longest glob `listFiles` takes, in characters. */
export const GLOB_LIMIT = 200

/** The most lines one page of `readDiff` holds. */
export const DIFF_PAGE = 150

/** The most characters of lines one answer of `readLines` or one page of `readDiff` holds. */
export const PAGE_CHARS = 30_000

/** The largest file `readLines` reads, in bytes: 1 MiB. */
export const READ_FILE_BYTES = 1024 * 1024

/**
 * The stage a model's call is made in: a pass that finds (`Find`, whose findings `reportFinding` records under its
 * pass), or a check of one finding (`Verify`, whose verdict `verdict` records under its check). Every stage is offered
 * the same tools, so a provider's cache keeps their declarations with the prompt's prefix; a tool of the other stage
 * answers a failed result that names the one to call.
 */
export const ReviewStage = Schema.Union([
  Schema.TaggedStruct("Find", { pass: PassNumber }),
  Schema.TaggedStruct("Verify", { check: CheckNumber }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ReviewStage = typeof ReviewStage.Type

/**
 * What the tools read: the repository, the commit under review, every file the pull request changes (the whole
 * parsed diff, not only what was packed), and the stage the calls are made in.
 */
export const Reviewed = Schema.Struct({
  repo: RepoName,
  at: CommitSha,
  files: Schema.Array(FileDiff),
  stage: ReviewStage,
})
export type Reviewed = typeof Reviewed.Type
