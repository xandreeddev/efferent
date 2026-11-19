import { Effect, Match, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Checkout } from "./checkout.port.js"
import { shownPath } from "./diff.entity.functions.js"
import { CLAIM_LIMIT, EVIDENCE_LIMIT, FindingKind, LineNumber, Severity } from "./finding.entity.js"
import { Findings } from "./findings.port.js"
import type { Reviewed } from "./review-tools.entity.js"
import { DIFF_PAGE, GLOB_LIMIT, LIST_FILES, LIST_LIMIT, PATTERN_LIMIT, READ_DIFF, READ_LINES, READ_LINES_LIMIT, REPORT_FINDING, SEARCH_CODE, SEARCH_LIMIT, SEARCH_LINE_SHOWN } from "./review-tools.entity.js"
import { diffPage, globRefusal, linesPage, listText, NOT_READ_BECAUSE, patternRefusal, recordedText, searchText, treePath } from "./review-tools.entity.functions.js"

const PATH = "A file's path from the repository's root, with / between folders, such as src/index.ts."

/** The tool that reads numbered lines of a file at the commit under review. */
export const ReadLines = Tool.make(READ_LINES, {
  description: `Read lines of a file as it is at the commit under review, numbered. Returns at most ${READ_LINES_LIMIT} lines from \`from\`, the file's number of lines, and the call that reads on. Only files are read: not a folder, a symbolic link, a submodule or a binary file. To see what the pull request changed in a file, use ${READ_DIFF}.`,
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
  description: `Read what the pull request changes in one file, written as the diff you were given is: each line with its number in the new file and + for an added line, a removed line with - and no number. Returns one page of at most ${DIFF_PAGE} lines and the call that reads the next. Every changed file can be read, those left out of the diff you were given included.`,
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
    claim: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(CLAIM_LIMIT)).annotate({ description: `What is wrong and what it causes, in one or two sentences, at most ${CLAIM_LIMIT} characters.` }),
    evidence: Schema.String.check(Schema.isMaxLength(EVIDENCE_LIMIT)).annotate({ description: `The lines the claim rests on, quoted exactly from the file, at most ${EVIDENCE_LIMIT} characters.` }),
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
})

/** The review's tools: a host offers them to the model and runs the calls with `reviewToolHandlers`. */
export const reviewTools = Toolkit.make(ReadLines, SearchCode, ListFiles, ReadDiff, ReportFinding)

/**
 * What the tools do, over the clone's objects at the commit under review (`Checkout`; never a folder on disk) and the
 * review's `Findings`. A path that leaves the repository, a folder, a link, a submodule, a binary or missing file, a
 * page past the end, a pattern git refuses: each a failed result in words that name what to do. A git command that
 * fails is a defect of the call, which `callTool` stores as its failed result.
 */
export const reviewToolHandlers = (reviewed: Reviewed) => reviewTools.toLayer(Effect.gen(function* () {
  const checkout = yield* Checkout
  const findings = yield* Findings
  const { repo, at } = reviewed
  return reviewTools.of({
    readLines: Effect.fn("review_tools.read_lines")(function* ({ path, from, count }) {
      const tracked = yield* Effect.fromResult(treePath(path))
      const entry = yield* checkout.entry(repo, at, tracked).pipe(Effect.orDie)
      const shown = shownPath(tracked)
      return yield* Match.valueTags(entry, {
        File: ({ blob }) => Effect.flatMap(Effect.orDie(checkout.blob(repo, blob)), (text) => Effect.fromResult(linesPage(tracked, text, from ?? 1, count ?? READ_LINES_LIMIT))),
        Link: () => Effect.fail(NOT_READ_BECAUSE.Link(shown)),
        Submodule: () => Effect.fail(NOT_READ_BECAUSE.Submodule(shown)),
        Folder: () => Effect.fail(NOT_READ_BECAUSE.Folder(shown)),
        Missing: () => Effect.fail(NOT_READ_BECAUSE.Missing(shown)),
      })
    }),
    searchCode: Effect.fn("review_tools.search_code")(function* ({ pattern, regex, path }) {
      yield* Effect.fromResult(patternRefusal(pattern))
      const within = path === undefined ? Option.none<string>() : Option.some(yield* Effect.fromResult(treePath(path)))
      const hits = yield* checkout.grep(repo, at, { pattern, regex: regex ?? false, path: within }).pipe(
        Effect.catchTag("PatternRefused", (refused) => Effect.fail(`git cannot read the pattern as a regular expression: ${refused.message}`)),
        Effect.catchTags({ CommandFailed: (error) => Effect.die(error), OutputCut: (error) => Effect.die(error), CommitMissing: (error) => Effect.die(error) }),
      )
      return searchText(pattern, Option.getOrNull(within), hits)
    }),
    listFiles: Effect.fn("review_tools.list_files")(function* ({ glob }) {
      yield* Effect.fromResult(globRefusal(glob))
      return listText(glob, yield* checkout.files(repo, at).pipe(Effect.orDie))
    }),
    readDiff: ({ path, page }) => Effect.fromResult(diffPage(reviewed.files, path, page ?? 1)),
    reportFinding: (report) => Effect.map(findings.record(reviewed.pass, report), recordedText),
  })
}))
