import { Result, Schema } from "effect"
import { BASH_ENV_ALLOWLIST, BashTermination, compileGlob } from "@xandreed/core"

/** The seven workspace tools, by the names the model calls them. */
export const WorkspaceToolName = Schema.Literals(["read", "write", "edit", "ls", "find", "grep", "bash"])
export type WorkspaceToolName = typeof WorkspaceToolName.Type

/**
 * The tools' three skills, by the short names `always` takes: `read`
 * (`workspace.read`: read, ls, find, grep), `edit` (`workspace.edit`: write,
 * edit) and `shell` (`workspace.shell`: bash).
 */
export const WorkspaceSkillName = Schema.Literals(["read", "edit", "shell"])
export type WorkspaceSkillName = typeof WorkspaceSkillName.Type

/** The grants the tools that change things need: `write` and `edit` need `fs.write`, `bash` needs `shell.exec`. */
export const WORKSPACE_PERMISSIONS = { write: "fs.write", exec: "shell.exec" } as const

const atLeast = (minimum: number) => Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimum))
const between = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

/** A directory below the workspace root, written relative to it (no leading `/`, no `..` segment). */
const InsideWorkspace = Schema.String.check(Schema.makeFilter((path: string) =>
  path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..") ? true : "a path relative to the workspace root, without a .. segment"))

/** A glob `compileGlob` accepts (dot entries included), so a bad `protect` or `exclude` is refused with the other options. */
const Glob = Schema.String.check(Schema.makeFilter((glob: string) =>
  Result.match(compileGlob(glob, { dot: true }), { onSuccess: () => true, onFailure: (reason) => `not a usable glob: ${reason}` })))

/**
 * How `workspaceToolsPlugin` (and `workspaceTools`) works on the workspace,
 * `SessionEnvironment.workspace`. Flat: plugin defaults merge one level deep.
 *
 * - `tools`: the tools to register (all seven by default). A skill whose
 *   tools are all left out is left out too.
 * - `always`: the skills active from a turn's first step: `read` by default.
 *   `edit` and `shell` here need their grants (`fs.write`, `shell.exec`), or
 *   the turn fails with `capability.forbidden`; otherwise the model loads
 *   them with `load_skill`, which refuses them without the grants.
 * - `confine`: refuse paths whose real location (links resolved, through the
 *   nearest ancestor that exists) is outside the workspace root.
 * - `protect`: globs, relative to the root, that `write` and `edit` refuse.
 * - `exclude`: names (or, with a `/`, paths relative to the root) `find`
 *   and `grep` never enter below the directory they search. Both lists are
 *   checked with `compileGlob` when the options are decoded.
 * - `maxLines`, `maxBytes`: the most `read`, `find` and `grep` show at once,
 *   and the tail of a command's output `bash` keeps.
 * - `lsEntries`, `findResults`, `grepMatches`: the most entries, paths and
 *   matching lines the model gets (a call may ask for fewer).
 * - `grepLineChars`: lines are cut to this many characters before `grep`
 *   matches them, and shown cut.
 * - `maxFileBytes`: the largest file `read`, `edit` and `grep` load, and
 *   the most of a command's output `bash` saves.
 * - `fuzzyEdit`: when an edit's text is not found, match it once more over
 *   whole lines with whitespace, Unicode compatibility forms and smart
 *   quotes normalised (the match must still be unique).
 * - `bashTimeoutMs`, `bashMaxTimeoutMs`: a command's timeout unless the
 *   model asks for another, and the most it may ask for.
 * - `bashEnv`: variables every command gets. `bashInheritEnv: true` passes
 *   the host's whole environment (provider keys included); otherwise only
 *   the names in `bashEnvAllow` (a trailing `*` matches a prefix) pass.
 *   `bashSessionEnv` adds `EFFERENT_SESSION_ID`, `EFFERENT_RUN_ID` and
 *   `EFFERENT_WORKSPACE`.
 * - `spillDir`: where a command's whole output (its first `maxFileBytes`)
 *   is saved once it is longer than `bash` shows (relative to the root;
 *   `null` saves nothing), keeping the newest `spillKeep` files.
 * - `progressMs`: how long output is gathered before it is published, as
 *   one `tool.progress` event per run of output from one stream.
 * - `environmentSection`, `sectionOrder`: the `workspace.environment`
 *   system-prompt section (tier `session`) and its order.
 */
export const WorkspaceToolsConfig = Schema.Struct({
  tools: Schema.Array(WorkspaceToolName),
  always: Schema.Array(WorkspaceSkillName),
  confine: Schema.Boolean,
  protect: Schema.Array(Glob),
  exclude: Schema.Array(Glob),
  maxLines: between(1, 100_000),
  maxBytes: between(1_024, 10_485_760),
  lsEntries: between(1, 100_000),
  findResults: between(1, 100_000),
  grepMatches: between(1, 10_000),
  grepLineChars: between(16, 100_000),
  maxFileBytes: between(1_024, 1_073_741_824),
  fuzzyEdit: Schema.Boolean,
  bashTimeoutMs: atLeast(1),
  bashMaxTimeoutMs: atLeast(1),
  bashEnv: Schema.Record(Schema.String, Schema.String),
  bashInheritEnv: Schema.Boolean,
  bashEnvAllow: Schema.Array(Schema.String),
  bashSessionEnv: Schema.Boolean,
  spillDir: Schema.NullOr(InsideWorkspace),
  spillKeep: between(1, 10_000),
  progressMs: between(1, 60_000),
  environmentSection: Schema.Boolean,
  sectionOrder: Schema.Int,
}).check(Schema.makeFilter((config) => config.bashTimeoutMs <= config.bashMaxTimeoutMs ? true : "bashTimeoutMs must not exceed bashMaxTimeoutMs"))
export type WorkspaceToolsConfig = typeof WorkspaceToolsConfig.Type

export const workspaceToolsDefaults: WorkspaceToolsConfig = {
  tools: ["read", "write", "edit", "ls", "find", "grep", "bash"],
  always: ["read"],
  confine: true,
  protect: [".git/**", ".efferent/**"],
  exclude: ["node_modules", ".git", ".efferent"],
  maxLines: 2_000,
  maxBytes: 51_200,
  lsEntries: 500,
  findResults: 1_000,
  grepMatches: 100,
  grepLineChars: 500,
  maxFileBytes: 33_554_432,
  fuzzyEdit: true,
  bashTimeoutMs: 120_000,
  bashMaxTimeoutMs: 600_000,
  bashEnv: {},
  bashInheritEnv: false,
  bashEnvAllow: BASH_ENV_ALLOWLIST,
  bashSessionEnv: false,
  spillDir: ".efferent/runtime/tool-output",
  spillKeep: 50,
  progressMs: 250,
  environmentSection: true,
  sectionOrder: 800,
}

/* ── what each tool takes and returns ── */

/** `read`: a file's lines from `offset` (1-based, default 1), at most `limit` of them (and never more than the configured window). */
export const ReadParams = Schema.Struct({
  path: Schema.String,
  offset: Schema.optionalKey(atLeast(1)),
  limit: Schema.optionalKey(atLeast(1)),
})
export type ReadParams = typeof ReadParams.Type

/**
 * What `read` found: a window of a text file's lines (`next` is the offset
 * to continue from when lines are left; `clipped` when the first line alone
 * was longer than the window's bytes and only its start is shown; `lossy`
 * when the file is not valid UTF-8 and the bytes that are not show as
 * U+FFFD, which `edit` refuses), or a binary file (a NUL byte in its first
 * 8 KB), with the media type its name suggests.
 */
export const ReadResult = Schema.Union([
  Schema.TaggedStruct("Text", {
    path: Schema.String,
    text: Schema.String,
    firstLine: Schema.Int,
    lastLine: Schema.Int,
    totalLines: Schema.Int,
    next: Schema.NullOr(Schema.Int),
    clipped: Schema.Boolean,
    lossy: Schema.Boolean,
  }),
  Schema.TaggedStruct("Binary", {
    path: Schema.String,
    bytes: Schema.Int,
    mediaType: Schema.NullOr(Schema.String),
  }),
])
export type ReadResult = typeof ReadResult.Type

export const WriteParams = Schema.Struct({ path: Schema.String, content: Schema.String })
export type WriteParams = typeof WriteParams.Type

/** What `write` did: how many bytes it wrote, and whether the file is new. */
export const WriteResult = Schema.Struct({ path: Schema.String, bytes: Schema.Int, created: Schema.Boolean })
export type WriteResult = typeof WriteResult.Type

/** One replacement: `oldText` (exactly once in the file) becomes `newText`. */
export const TextEdit = Schema.Struct({ oldText: Schema.String, newText: Schema.String })
export type TextEdit = typeof TextEdit.Type

export const EditParams = Schema.Struct({ path: Schema.String, edits: Schema.NonEmptyArray(TextEdit) })
export type EditParams = typeof EditParams.Type

/**
 * What `edit` did: how many blocks it replaced, whether any was found only
 * after normalising, the first changed line, and the change as a unified
 * diff (for a host's UI; the model is shown a one-line summary).
 */
export const EditResult = Schema.Struct({
  path: Schema.String,
  replaced: Schema.Int,
  normalized: Schema.Boolean,
  firstChangedLine: Schema.Int,
  diff: Schema.String,
})
export type EditResult = typeof EditResult.Type

export const LsParams = Schema.Struct({ path: Schema.optionalKey(Schema.String), limit: Schema.optionalKey(atLeast(1)) })
export type LsParams = typeof LsParams.Type

export const LsEntry = Schema.Struct({ name: Schema.String, kind: Schema.Literals(["file", "directory", "symlink", "other"]) })
export type LsEntry = typeof LsEntry.Type

/** A directory's entries by name, at most the limit of them; `total` counts them all. */
export const LsResult = Schema.Struct({ path: Schema.String, entries: Schema.Array(LsEntry), total: Schema.Int })
export type LsResult = typeof LsResult.Type

export const FindParams = Schema.Struct({ pattern: Schema.String, path: Schema.optionalKey(Schema.String), limit: Schema.optionalKey(atLeast(1)) })
export type FindParams = typeof FindParams.Type

/** The files a glob matched, as paths relative to the workspace root; `truncated` when more matched. */
export const FindResult = Schema.Struct({ pattern: Schema.String, path: Schema.String, paths: Schema.Array(Schema.String), truncated: Schema.Boolean })
export type FindResult = typeof FindResult.Type

export const GrepParams = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optionalKey(Schema.String),
  glob: Schema.optionalKey(Schema.String),
  ignoreCase: Schema.optionalKey(Schema.Boolean),
  literal: Schema.optionalKey(Schema.Boolean),
  context: Schema.optionalKey(between(0, 10)),
  limit: Schema.optionalKey(atLeast(1)),
})
export type GrepParams = typeof GrepParams.Type

/** One line `grep` shows: a matching line, or (`match: false`) a line of context around one. `text` is cut to the configured width. */
export const GrepLine = Schema.Struct({ path: Schema.String, line: Schema.Int, text: Schema.String, match: Schema.Boolean })
export type GrepLine = typeof GrepLine.Type

/**
 * What `grep` found: the matching lines (with their context) in walk order,
 * how many lines matched and in how many files, whether it stopped at the
 * limit, and how many files it skipped (binary, larger than `maxFileBytes`,
 * or resolving outside the workspace).
 */
export const GrepResult = Schema.Struct({
  pattern: Schema.String,
  path: Schema.String,
  lines: Schema.Array(GrepLine),
  matches: Schema.Int,
  files: Schema.Int,
  truncated: Schema.Boolean,
  skipped: Schema.Int,
})
export type GrepResult = typeof GrepResult.Type

/** `bash`: the command, its timeout in seconds, and what to write to its standard input. */
export const BashParams = Schema.Struct({
  command: Schema.String,
  timeout: Schema.optionalKey(atLeast(1)),
  stdin: Schema.optionalKey(Schema.String),
})
export type BashParams = typeof BashParams.Type

/**
 * How a command went: the tail of its output (stdout and stderr in the
 * order they arrived), how it ended, and, when the output was longer than
 * the tail, where the whole of it was saved (`fullOutput`, relative to the
 * workspace root; null when nothing was saved). The file holds at most
 * `maxFileBytes` of the output, its start: `fullOutputCut` when there was
 * more, which was not saved.
 */
export const BashToolResult = Schema.Struct({
  command: Schema.String,
  output: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  termination: BashTermination,
  truncated: Schema.Boolean,
  totalLines: Schema.Int,
  fullOutput: Schema.NullOr(Schema.String),
  fullOutputCut: Schema.Boolean,
  durationMs: Schema.Number,
})
export type BashToolResult = typeof BashToolResult.Type

/** The tools' names and schemas, for `onTool` subscriptions (a UI showing `edit` diffs, say). */
export const workspaceToolSchemas = {
  read: { name: "read", parametersSchema: ReadParams, successSchema: ReadResult },
  write: { name: "write", parametersSchema: WriteParams, successSchema: WriteResult },
  edit: { name: "edit", parametersSchema: EditParams, successSchema: EditResult },
  ls: { name: "ls", parametersSchema: LsParams, successSchema: LsResult },
  find: { name: "find", parametersSchema: FindParams, successSchema: FindResult },
  grep: { name: "grep", parametersSchema: GrepParams, successSchema: GrepResult },
  bash: { name: "bash", parametersSchema: BashParams, successSchema: BashToolResult },
} as const
