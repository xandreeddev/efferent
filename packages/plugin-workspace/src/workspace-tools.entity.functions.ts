import { Option } from "effect"
import type { BashOptions } from "@xandreed/core"
import { renderSearchLines } from "./text-search.entity.functions.js"
import { formatBytes, headLines } from "./text-window.entity.functions.js"
import type { BashToolResult, EditResult, FindResult, GrepResult, LsResult, ReadResult, WorkspaceSkillName, WorkspaceToolName, WorkspaceToolsConfig, WriteResult } from "./workspace-tools.entity.js"

/** The skill each tool belongs to, by its short name. */
export const skillOfTool: Readonly<Record<WorkspaceToolName, WorkspaceSkillName>> = {
  read: "read", ls: "read", find: "read", grep: "read", write: "edit", edit: "edit", bash: "shell",
}

const seconds = (ms: number): string => `${Math.round(ms / 1_000)} s`
const listed = (names: ReadonlyArray<string>): string => names.length === 0 ? "nothing" : names.join(", ")

/** What the model is told each tool does, with the configured limits in it. */
export const toolDescriptions = (config: WorkspaceToolsConfig): Readonly<Record<WorkspaceToolName, string>> => ({
  read: `Read a text file of the workspace. Shows at most ${config.maxLines} lines or ${formatBytes(config.maxBytes)} at a time; when more is left, the result says which offset to continue from. offset is the first line to show (1-based), limit how many lines. A binary file is reported, not shown. To see a directory, use ls.`,
  write: "Create a file, or replace all of an existing one, with content; missing directories are created. To change part of a file, use edit. Emptying a non-empty file is refused.",
  edit: "Change part of a file by replacing exact text. Each edit's oldText must appear exactly once in the file: copy it from read (without the notice lines), with enough surrounding lines to be unique. All edits are matched against the file as it was before this call and must not overlap; newText replaces oldText (empty to delete it). Line endings and a byte-order mark are kept.",
  ls: `List a directory (by default the workspace root): one entry per line, directories ending in /, symbolic links in @. At most ${config.lsEntries} entries.`,
  find: `Find files whose path matches a glob pattern, relative to path (by default the workspace root): * and ? match within a name, ** any number of directories, {a,b} either; e.g. **/*.ts or src/**/test_*.py. Never looks inside ${listed(config.exclude)} or symbolic links. At most ${config.findResults} paths.`,
  grep: `Search file contents for a regular expression (JavaScript syntax), or for plain text with literal: true. path is a file or a directory (by default the workspace root); glob limits the files searched (*.ts searches every directory). Shows path:line:text for each matching line, and context lines around each match when asked. Lines are cut to ${config.grepLineChars} characters before matching. At most ${config.grepMatches} matching lines; binary files, ${listed(config.exclude)} and symbolic links are skipped.`,
  bash: `Run a shell command with bash -c in the workspace root. timeout is in seconds (default ${seconds(config.bashTimeoutMs)}, at most ${seconds(config.bashMaxTimeoutMs)}); stdin is written to the command's standard input. Returns the exit code and the output, stdout and stderr in the order they came. Output longer than ${config.maxLines} lines or ${formatBytes(config.maxBytes)} is cut to its end${config.spillDir === null ? "" : `, and the whole of it (up to ${formatBytes(config.maxFileBytes)}) is saved to a file you can read`}. A non-zero exit code is a result to read, not a failure. Anything the command leaves running may be stopped when it returns.`,
})

/** The text of the `workspace.environment` section: where the workspace is and how the enabled tools behave there. */
export const environmentText = (root: string, config: WorkspaceToolsConfig, tools: ReadonlyArray<WorkspaceToolName>): string => {
  const has = (tool: WorkspaceToolName) => tools.includes(tool)
  return [
    "## Workspace",
    `The workspace is ${root}. Give paths relative to it${config.confine ? "; the tools refuse paths that lead outside it." : "."}`,
    ...(has("read") ? [`read shows a file ${config.maxLines} lines or ${formatBytes(config.maxBytes)} at a time; continue with the offset it gives.`] : []),
    ...(has("find") || has("grep") ? [`find and grep never look inside ${listed(config.exclude)}.`] : []),
    ...(has("edit") ? ["edit replaces exact text: read the file first and copy the text to change from it."] : []),
    ...(has("write") || has("edit") ? [config.protect.length === 0 ? "" : `write and edit leave ${listed(config.protect)} alone.`] : []),
    ...(has("bash") ? [`bash runs commands in the workspace root with a ${seconds(config.bashTimeoutMs)} timeout.${config.spillDir === null ? "" : " When their output is cut, the whole of it is saved to a file under " + config.spillDir + " that read can open."}`] : []),
  ].filter((line) => line.length > 0).join("\n")
}

/**
 * The environment of a command the bash tool runs: the configured
 * variables, the session's when `bashSessionEnv` is set, and the parent
 * environment through the allowlist (or all of it with `bashInheritEnv`).
 */
export const bashEnvironment = (config: WorkspaceToolsConfig, session: Option.Option<{ readonly sessionId: string; readonly runId: string; readonly workspace: string }>): Pick<BashOptions, "env" | "inheritEnv"> => ({
  env: {
    ...(config.bashSessionEnv ? Option.match(session, {
      onNone: () => ({}),
      onSome: (run) => ({ EFFERENT_SESSION_ID: run.sessionId, EFFERENT_RUN_ID: run.runId, EFFERENT_WORKSPACE: run.workspace }),
    }) : {}),
    ...config.bashEnv,
  },
  inheritEnv: config.bashInheritEnv ? true : config.bashEnvAllow,
})

/* ── what the model sees of each result ── */

export const renderRead = (result: ReadResult): string => result._tag === "Binary"
  ? `[${result.path} is a binary file (${formatBytes(result.bytes)}${result.mediaType === null ? "" : `, ${result.mediaType}`}); it cannot be shown as text.]`
  : result.totalLines === 0 ? `[${result.path} is empty.]`
  : [
    result.text,
    ...(result.clipped ? [`[Line ${result.firstLine} is longer than the window; only its start is shown. Use bash (cut, head -c) to see the rest.]`] : []),
    ...(result.lossy ? [`[${result.path} is not valid UTF-8: bytes that are not show as �. edit refuses such a file; change it with bash.]`] : []),
    ...(result.next === null ? [] : [`[Showing lines ${result.firstLine}-${result.lastLine} of ${result.totalLines}. Use offset=${result.next} to continue.]`]),
  ].join("\n")

export const compactRead = (result: ReadResult): string => result._tag === "Binary"
  ? `(read ${result.path}: binary, ${formatBytes(result.bytes)})`
  : `(read ${result.path}: lines ${result.firstLine}-${result.lastLine} of ${result.totalLines})`

export const renderWrite = (result: WriteResult): string =>
  `${result.created ? "Created" : "Replaced"} ${result.path} (${formatBytes(result.bytes)}).`

export const compactWrite = (result: WriteResult): string => `(${result.created ? "created" : "replaced"} ${result.path}: ${formatBytes(result.bytes)})`

export const renderEdit = (result: EditResult): string =>
  `Replaced ${result.replaced} block${result.replaced === 1 ? "" : "s"} in ${result.path}; the first change is at line ${result.firstChangedLine}.${result.normalized ? " Some text matched only once whitespace and quotes were normalised: read the changed lines to check them." : ""}`

export const compactEdit = (result: EditResult): string => `(edited ${result.path}: ${result.replaced} block${result.replaced === 1 ? "" : "s"} from line ${result.firstChangedLine})`

const lsSuffix = { file: "", directory: "/", symlink: "@", other: "" } as const

export const renderLs = (result: LsResult): string => result.total === 0 ? `[${result.path} is empty.]` : [
  ...result.entries.map((entry) => `${entry.name}${lsSuffix[entry.kind]}`),
  ...(result.entries.length < result.total ? [`[Showing ${result.entries.length} of ${result.total} entries. Use find with a pattern to narrow them down.]`] : []),
].join("\n")

export const compactLs = (result: LsResult): string => `(listed ${result.path}: ${result.total} entries)`

export const renderFind = (result: FindResult, maxLines: number, maxBytes: number): string => {
  if (result.paths.length === 0) return `No files under ${result.path} match ${result.pattern}.`
  const head = headLines(result.paths, maxLines, maxBytes)
  return [
    ...head.lines,
    ...(head.omitted > 0 ? [`[${head.omitted} more paths not shown. Narrow the pattern or the path.]`]
      : result.truncated ? [`[Stopped at ${result.paths.length} paths; there are more. Narrow the pattern or the path.]`] : []),
  ].join("\n")
}

export const compactFind = (result: FindResult): string => `(find ${result.pattern} in ${result.path}: ${result.paths.length}${result.truncated ? "+" : ""} paths)`

export const renderGrep = (result: GrepResult, withContext: boolean, maxLines: number, maxBytes: number): string => {
  const skipped = result.skipped === 0 ? [] : [`[${result.skipped} file${result.skipped === 1 ? "" : "s"} skipped: binary, larger than the read limit, or leading outside the workspace.]`]
  if (result.matches === 0) return [`No matches for ${result.pattern} in ${result.path}.`, ...skipped].join("\n")
  const head = headLines(renderSearchLines(result.lines, withContext), maxLines, maxBytes)
  return [
    ...head.lines,
    ...(head.omitted > 0 ? [`[${head.omitted} more lines not shown. Narrow the pattern or the path.]`] : []),
    ...(result.truncated ? [`[Stopped at ${result.matches} matching lines; there are more. Narrow the pattern or the path, or raise limit.]`] : []),
    ...skipped,
  ].join("\n")
}

export const compactGrep = (result: GrepResult): string =>
  `(grep ${result.pattern} in ${result.path}: ${result.matches}${result.truncated ? "+" : ""} matching lines in ${result.files} files)`

/** How a command ended, in a sentence. */
const endOf = (result: BashToolResult): string =>
  result.termination === "timeout" ? `[The command was killed after ${result.durationMs < 10_000 ? `${(result.durationMs / 1_000).toFixed(1)} s` : seconds(result.durationMs)}, at its timeout.]`
    : result.termination === "interrupted" ? "[The command was stopped before it finished.]"
    : result.termination === "signal" ? `[The command was killed by ${result.signal ?? "a signal"}.]`
    : `[Exit code ${result.exitCode ?? "unknown"}.]`

/** What was left out of a command's output, and where the whole of it (or its start) is. */
const cutOf = (result: BashToolResult): string => {
  const shownLines = result.output.length === 0 ? 0 : result.output.split("\n").length
  const what = shownLines < result.totalLines ? `Output cut to its last ${shownLines} of ${result.totalLines} lines.` : "Output cut: only the end of its last line is shown."
  const saved = result.fullOutput === null ? ""
    : result.fullOutputCut ? ` Only its start was saved, in ${result.fullOutput}: the output grew past the size read opens, and the rest was not kept. Read the file with offset to see that start; to see the rest, run the command again with its output filtered (grep, tail, sed -n).`
    : ` The whole output is in ${result.fullOutput}; read it with offset to see the rest.`
  return `[${what}${saved}]`
}

export const renderBash = (result: BashToolResult): string => [
  ...(result.output.length === 0 ? ["(no output)"] : [result.output]),
  ...(result.truncated ? [cutOf(result)] : []),
  endOf(result),
].join("\n")

export const compactBash = (result: BashToolResult): string =>
  `(ran ${result.command.length > 80 ? `${result.command.slice(0, 80)}…` : result.command}: ${result.termination === "exit" ? `exit ${result.exitCode ?? "?"}` : result.termination}${result.fullOutput === null ? "" : `; output in ${result.fullOutput}`})`
