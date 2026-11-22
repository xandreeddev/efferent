import { Effect, Match, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Checkout } from "./checkout.port.js"
import { shownPath } from "./diff.entity.functions.js"
import { CLAIM_LIMIT, EVIDENCE_LIMIT, FindingKind, LineNumber, QUOTE_LIMIT, REASON_LIMIT, Severity, VerdictOutcome } from "./finding.entity.js"
import { Findings } from "./findings.port.js"
import type { Reviewed } from "./review-tools.entity.js"
import { DIFF_PAGE, GLOB_LIMIT, LIST_FILES, LIST_LIMIT, PAGE_CHARS, PATTERN_LIMIT, READ_DIFF, READ_FILE_BYTES, READ_LINES, READ_LINES_LIMIT, REPORT_FINDING, SEARCH_CODE, SEARCH_LIMIT, SEARCH_LINE_SHOWN, VERDICT } from "./review-tools.entity.js"
import { checkedReport, diffPage, GIT_FAILED, globRefusal, judgedText, keptReport, keptVerdict, linesPage, listText, NOT_CHECKING_NOW, NOT_FINDING_NOW, NOT_READ_BECAUSE, patternRefusal, recordedText, REGEX_REFUSED, SEARCH_TOO_BIG, SEARCH_TOO_LONG, searchText, tooLarge, treePath } from "./review-tools.entity.functions.js"
import type { CheckoutError } from "./checkout.port.js"

/** A git command of a tool's that failed: logged whole for the host, and answered in fixed words, never git's. */
const gitFailed = (error: CheckoutError) => Effect.logWarning("a review tool's git command failed", error).pipe(Effect.andThen(Effect.fail(GIT_FAILED)))

const PATH = "A file's path from the repository's root, with / between folders, such as src/index.ts."

/** The tool that reads numbered lines of a file at the commit under review. */
export const ReadLines = Tool.make(READ_LINES, {
  description: `Read lines of a file as it is at the commit under review, numbered. Returns at most ${READ_LINES_LIMIT} lines from \`from\` (fewer when they hold more than ${PAGE_CHARS} characters), the file's number of lines, and the call that reads on. Only files of at most ${READ_FILE_BYTES} bytes are read: not a folder, a symbolic link, a submodule or a binary file. To see what the pull request changed in a file, use ${READ_DIFF}.`,
  parameters: Schema.Struct({
    path: Schema.String.annotate({ description: PATH }),
    from: Schema.optionalKey(LineNumber.annotate({ description: "The first line to read, from 1. Left out, 1." })),
    count: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: READ_LINES_LIMIT })).annotate({ description: `How many lines to read, at most ${READ_LINES_LIMIT}. Left out, ${READ_LINES_LIMIT}.` })),
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
})

/** The tool that searches the tracked files at the commit under review. */
export const SearchCode = Tool.make(SEARCH_CODE, {
  description: `Search the tracked files at the commit under review for a text. Returns each line that holds it as path:line: text, at most ${SEARCH_LIMIT} lines of at most ${SEARCH_LINE_SHOWN} characters, and how many more there are. The pattern is read as it is written; set regex to true to read it as an extended regular expression. Give path to search one file or folder. Use ${READ_LINES} to read around a line it finds.`,
  parameters: Schema.Struct({
    pattern: Schema.String.annotate({ description: `The text to find, at most ${PATTERN_LIMIT} characters, such as a function's name.` }),
    regex: Schema.optionalKey(Schema.Boolean.annotate({ description: "True to read the pattern as an extended regular expression. Left out, false." })),
    path: Schema.optionalKey(Schema.String.annotate({ description: "A file or folder to search in, such as src. Left out, every tracked file." })),
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
})

/** The tool that lists the tracked files at the commit under review that a glob matches. */
export const ListFiles = Tool.make(LIST_FILES, {
  description: `List the tracked files at the commit under review whose paths match a glob. Returns at most ${LIST_LIMIT} paths, in order, and how many more match. In a glob, * matches any characters but /, ** any characters, and ? one character but /: src/**/*.ts lists the TypeScript files under src.`,
  parameters: Schema.Struct({
    glob: Schema.String.annotate({ description: `The glob, at most ${GLOB_LIMIT} characters, such as src/**/*.ts.` }),
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
})

/** The tool that reads what the pull request changes in one file. */
export const ReadDiff = Tool.make(READ_DIFF, {
  description: `Read what the pull request changes in one file, written as the diff you were given is: each line with its number in the new file and + for an added line, a removed line with - and no number. Returns one page of at most ${DIFF_PAGE} lines (fewer when they hold more than ${PAGE_CHARS} characters) and the call that reads the next. Every changed file can be read, those left out of the diff you were given included.`,
  parameters: Schema.Struct({
    path: Schema.String.annotate({ description: `${PATH} The pull request must change it.` }),
    page: Schema.optionalKey(LineNumber.annotate({ description: "The page to read, from 1. Left out, 1." })),
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
})

/** The tool the model reports a finding with. */
export const ReportFinding = Tool.make(REPORT_FINDING, {
  description: "Report one problem the pull request brings in on lines it changes: a bug, a security problem, or a broken rule of the repository's. Give the file and its lines as they are at the commit under review, and quote those lines as the evidence. Returns the finding's number. Report each problem once.",
  parameters: Schema.Struct({
    path: Schema.String.annotate({ description: PATH }),
    line: LineNumber.annotate({ description: "The first line of the problem, numbered as at the commit under review." }),
    endLine: Schema.optionalKey(LineNumber.annotate({ description: "The last line, when the problem spans more than one. Left out, line." })),
    kind: FindingKind.annotate({ description: "bug, security or rule (a rule the repository's instructions state)." }),
    severity: Severity.annotate({ description: "high, medium or low: how much harm the problem does if it is merged." }),
    claim: Schema.String.check(Schema.isMinLength(1)).annotate({ description: `What is wrong and what it causes, in one to three sentences; past ${CLAIM_LIMIT} characters it is cut.` }),
    evidence: Schema.optionalKey(Schema.String.annotate({ description: `The lines the claim rests on, quoted exactly from the file; past ${EVIDENCE_LIMIT} characters only the first whole lines are kept. Left out, the finding is still recorded, and its check reads the cited lines.` })),
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
})

/** The tool the model gives its verdict on a finding with, when it checks one. */
export const Verdict = Tool.make(VERDICT, {
  description: `Give your verdict on the finding you were asked to check, once, after reading the lines you need. Only when you check a finding; to report a problem, use ${REPORT_FINDING}.`,
  parameters: Schema.Struct({
    outcome: VerdictOutcome.annotate({ description: "confirmed: the problem is real and the pull request brings it in; refuted: it is not; unsure: you cannot tell from what you read." }),
    reason: Schema.String.check(Schema.isMinLength(1)).annotate({ description: `Why, in one to three sentences; past ${REASON_LIMIT} characters it is cut.` }),
    quote: Schema.String.annotate({ description: `The lines of the file the finding cites that your verdict rests on, quoted exactly as they are at the commit under review, without line numbers; past ${QUOTE_LIMIT} characters only the first whole lines are kept.` }),
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
})

/**
 * The review's tools: a host offers them to the model and runs the calls with `reviewToolHandlers`. Every stage is
 * offered all of them, so the tools' declarations stay with the prompt's cached prefix.
 */
export const reviewTools = Toolkit.make(ReadLines, SearchCode, ListFiles, ReadDiff, ReportFinding, Verdict)

/**
 * What the tools do, over the clone's objects at the commit under review (`Checkout`; never a folder on disk) and the
 * review's `Findings`. A path that leaves the repository, a folder, a link, a submodule, a binary or missing file, a
 * page past the end, a pattern git refuses, a search too long or too big: each a failed result in words that name
 * what to do. A git command that fails otherwise is logged whole and answered in fixed words (`GIT_FAILED`), never
 * git's own, which may name a host path.
 */
export const reviewToolHandlers = (reviewed: Reviewed) => reviewTools.toLayer(Effect.gen(function* () {
  const checkout = yield* Checkout
  const findings = yield* Findings
  const { repo, at } = reviewed
  return reviewTools.of({
    readLines: Effect.fn("review_tools.read_lines")(function* ({ path, from, count }) {
      const tracked = yield* Effect.fromResult(treePath(path))
      const entry = yield* checkout.entry(repo, at, tracked).pipe(Effect.catch(gitFailed))
      const shown = shownPath(tracked)
      return yield* Match.valueTags(entry, {
        // The size first: a file over READ_FILE_BYTES is refused before a byte of it is read.
        File: ({ blob, bytes }) => bytes > READ_FILE_BYTES
          ? Effect.fail(tooLarge(tracked, bytes))
          : Effect.flatMap(Effect.catch(checkout.blob(repo, blob), gitFailed), (text) => Effect.fromResult(linesPage(tracked, text, from ?? 1, count ?? READ_LINES_LIMIT))),
        Link: () => Effect.fail(NOT_READ_BECAUSE.Link(shown)),
        Submodule: () => Effect.fail(NOT_READ_BECAUSE.Submodule(shown)),
        Folder: () => Effect.fail(NOT_READ_BECAUSE.Folder(shown)),
        Missing: () => Effect.fail(NOT_READ_BECAUSE.Missing(shown)),
      })
    }),
    searchCode: Effect.fn("review_tools.search_code")(function* ({ pattern, regex, path }) {
      yield* Effect.fromResult(patternRefusal(pattern))
      const within = path === undefined ? Option.none<string>() : Option.some(yield* Effect.fromResult(treePath(path)))
      // A file's lines are read up to one past the most shown, so a file that holds more says the counts are at least those.
      const maxPerFile = SEARCH_LIMIT + 1
      const hits = yield* checkout.grep(repo, at, { pattern, regex: regex ?? false, path: within, maxPerFile }).pipe(
        Effect.catchTags({
          PatternRefused: () => Effect.fail(REGEX_REFUSED),
          OutputCut: () => Effect.fail(SEARCH_TOO_BIG),
          CommandFailed: (error) => (error.reason === "timed-out" ? Effect.fail(SEARCH_TOO_LONG) : gitFailed(error)),
          CommitMissing: gitFailed,
        }),
      )
      const perFile = new Map<string, number>()
      for (const hit of hits) perFile.set(hit.path, (perFile.get(hit.path) ?? 0) + 1)
      return searchText(pattern, Option.getOrNull(within), hits, [...perFile.values()].some((count) => count >= maxPerFile))
    }),
    listFiles: Effect.fn("review_tools.list_files")(function* ({ glob }) {
      yield* Effect.fromResult(globRefusal(glob))
      return listText(glob, yield* checkout.files(repo, at).pipe(Effect.catch(gitFailed)))
    }),
    readDiff: ({ path, page }) => Effect.fromResult(diffPage(reviewed.files, path, page ?? 1)),
    reportFinding: (report) => Match.valueTags(reviewed.stage, {
      // A report with no evidence is recorded with none: on the eval one turn left it out of 11 of its 13 reports, and
      // the failed results that named the missing key did not bring it back.
      Find: ({ turn }) => Effect.flatMap(Effect.fromResult(checkedReport(keptReport({ ...report, evidence: report.evidence ?? "" }), reviewed.files)), (checked) => Effect.map(findings.record(reviewed.run, turn, checked), recordedText)),
      Verify: () => Effect.fail(NOT_FINDING_NOW),
    }),
    verdict: (report) => Match.valueTags(reviewed.stage, {
      Find: () => Effect.fail(NOT_CHECKING_NOW),
      Verify: ({ check }) => Effect.map(findings.judge(reviewed.run, check, keptVerdict(report)), judgedText),
    }),
  })
}))
