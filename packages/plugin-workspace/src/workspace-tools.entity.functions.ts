import { Effect, Match, Option, Schema } from "effect"
import { ImageMediaType, MEDIA_LIMITS, mediaFromBytes, sniffImageType } from "@xandreed/core"
import type { AttachmentRejectedReason, BashOptions, Media } from "@xandreed/core"
import { renderSearchLines } from "./text-search.entity.functions.js"
import { formatBytes, headLines, mediaTypeOf } from "./text-window.entity.functions.js"
import { FindParams, GrepParams, LsParams, ReadParams } from "./workspace-tools.entity.js"
import type { BashToolResult, EditResult, FindResult, GrepResult, LsResult, ReadResult, WorkspaceSkillName, WorkspaceToolName, WorkspaceToolsConfig, WriteResult } from "./workspace-tools.entity.js"

/** The skill each tool belongs to, by its short name. */
export const skillOfTool: Readonly<Record<WorkspaceToolName, WorkspaceSkillName>> = {
  read: "read", ls: "read", find: "read", grep: "read", write: "edit", edit: "edit", bash: "shell",
}

const seconds = (ms: number): string => `${Math.round(ms / 1_000)} s`
/**
 * The largest image `read` returns, as the model is told it:
 * `MEDIA_LIMITS.imageBytes` (3.75 MB), or `maxFileBytes` when that is less
 * (`read` refuses a larger file before it reads it). Rounded down, so never
 * more than the limit.
 */
const imageLimit = (config: WorkspaceToolsConfig): string => {
  const bytes = Math.min(MEDIA_LIMITS.imageBytes, config.maxFileBytes)
  return bytes < 1_048_576 ? `${Math.floor(bytes * 100 / 1_024) / 100} KB` : `${Math.floor(bytes * 100 / 1_048_576) / 100} MB`
}
/** Names in a sentence: `a, b and c` (or `or`). */
const inWords = (names: ReadonlyArray<string>, joiner: "and" | "or"): string =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${joiner} ${names.at(-1)}`
/** `n` and the noun for it, one or many: `1 path`, `2 paths`. */
const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
/** A directory as a sentence names it: the workspace root for `.`, else its path. */
const place = (path: string): string => path === "." ? "the workspace root" : path

/** A `limit` from 1 to the configured cap, which the tool's parameter schema shows the model as its maximum. */
const limitUpTo = (maximum: number) => Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum })))

/**
 * The parameters `read`, `ls`, `find` and `grep` take under `config`: their
 * `limit` goes up to the configured cap (`maxLines`, `lsEntries`,
 * `findResults`, `grepMatches`), so the model is shown the real maximum and
 * a larger one is refused rather than quietly lowered.
 */
export const toolParameters = (config: WorkspaceToolsConfig) => ({
  read: Schema.Struct({ ...ReadParams.fields, limit: limitUpTo(config.maxLines) }),
  ls: Schema.Struct({ ...LsParams.fields, limit: limitUpTo(config.lsEntries) }),
  find: Schema.Struct({ ...FindParams.fields, limit: limitUpTo(config.findResults) }),
  grep: Schema.Struct({ ...GrepParams.fields, limit: limitUpTo(config.grepMatches) }),
})

/** What the model is told each tool does, with the configured limits in it. */
export const toolDescriptions = (config: WorkspaceToolsConfig): Readonly<Record<WorkspaceToolName, string>> => ({
  read: `Read a text file of the workspace${config.readImages ? ", or look at an image" : ""}. Shows at most ${config.maxLines} lines or ${formatBytes(config.maxBytes)} at a time; when more is left, the result says which offset to continue from. offset is the first line to show (1-based), limit how many lines (at most ${config.maxLines}). ${config.readImages ? `A PNG, JPEG, GIF or WebP image (up to ${imageLimit(config)} and ${MEDIA_LIMITS.maxPixels} pixels a side) is returned as an image you can see; another binary file is reported, not shown.` : "A binary file is reported, not shown."} To see a directory, use ls.`,
  write: "Create a file, or replace all of an existing one, with content; missing directories are created. To change part of a file, use edit. Emptying a non-empty file is refused.",
  edit: "Change part of a file by replacing exact text. Each edit's oldText must appear exactly once in the file: copy it from read (without the notice lines), with enough surrounding lines to be unique. All edits are matched against the file as it was before this call and must not overlap; newText replaces oldText (empty to delete it). Line endings and a byte-order mark are kept.",
  ls: `List a directory (by default the workspace root): one entry per line, directories ending in /, symbolic links in @. At most ${config.lsEntries} entries; limit (1 to ${config.lsEntries}) asks for fewer.`,
  find: `Find files whose path matches a glob pattern, relative to path (by default the workspace root): * and ? match within a name, ** any number of directories, {a,b} either; e.g. **/*.ts or src/**/test_*.py. Never looks inside ${inWords([...config.exclude, "symbolic links"], "or")}. At most ${config.findResults} paths; limit (1 to ${config.findResults}) asks for fewer.`,
  grep: `Search file contents for a regular expression (JavaScript syntax), or for plain text with literal: true. path is a file or a directory (by default the workspace root); glob limits the files searched (*.ts searches every directory). Shows path:line:text for each matching line, and context lines around each match when asked. Lines are cut to ${config.grepLineChars} characters before matching. At most ${config.grepMatches} matching lines; limit (1 to ${config.grepMatches}) asks for fewer. ${inWords(["Binary files", ...config.exclude, "symbolic links"], "and")} are skipped, and files that cannot be read are named.`,
  bash: `Run a shell command with bash -c in the workspace root. timeout is in seconds (default ${seconds(config.bashTimeoutMs)}, at most ${seconds(config.bashMaxTimeoutMs)}); stdin is written to the command's standard input. Returns the exit code and the output, stdout and stderr in the order they came. Output longer than ${config.maxLines} lines or ${formatBytes(config.maxBytes)} is cut to its end${config.spillDir === null ? "" : `, and the whole of it (up to ${formatBytes(config.maxFileBytes)}) is saved to a file you can read`}. A non-zero exit code is a result to read, not a failure. Anything the command leaves running may be stopped when it returns.`,
})

/** The text of the `workspace.environment` section: where the workspace is and how the enabled tools behave there. */
export const environmentText = (root: string, config: WorkspaceToolsConfig, tools: ReadonlyArray<WorkspaceToolName>): string => {
  const has = (tool: WorkspaceToolName) => tools.includes(tool)
  return [
    "## Workspace",
    `The workspace is ${root}. Give paths relative to it${config.confine ? "; the tools refuse paths that lead outside it." : "."}`,
    ...(has("read") ? [`read shows a file ${config.maxLines} lines or ${formatBytes(config.maxBytes)} at a time; continue with the offset it gives.`] : []),
    ...((has("find") || has("grep")) && config.exclude.length > 0 ? [`find and grep never look inside ${config.exclude.join(", ")}.`] : []),
    ...(has("edit") ? ["edit replaces exact text: read the file first and copy the text to change from it."] : []),
    ...(has("write") || has("edit") ? [config.protect.length === 0 ? "" : `write and edit leave ${config.protect.join(", ")} alone.`] : []),
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

/**
 * What `read` returns for a binary file (a NUL byte in its first 8 KB).
 * With `readImages`, bytes that are a PNG, JPEG, GIF or WebP image (sniffed,
 * whatever the name says) become an `Image` through `mediaFromBytes`, named
 * by the path; an image it refuses (over `MEDIA_LIMITS.imageBytes`, over
 * `MEDIA_LIMITS.maxPixels` a side, or a header without a size) is an
 * `ImageRejected` note, without the bytes. Anything else is `Binary`, with
 * `nameType`: the media type the name suggests, as the result carries it
 * (`null` for none; the adapter reads it with `mediaTypeOf`).
 */
export const binaryRead = (path: string, bytes: Uint8Array, readImages: boolean, nameType: string | null): Effect.Effect<ReadResult> =>
  Option.match(readImages ? sniffImageType(bytes) : Option.none(), {
    onNone: () => Effect.succeed<ReadResult>({ _tag: "Binary", path, bytes: bytes.length, mediaType: nameType }),
    onSome: (mediaType) => mediaFromBytes(bytes, { name: path }).pipe(Effect.match({
      onSuccess: (image): ReadResult => ({ _tag: "Image", path, image }),
      onFailure: (rejected): ReadResult => ({ _tag: "ImageRejected", path, mediaType, bytes: bytes.length, reason: rejected.reason, message: rejected.message }),
    })),
  })

/**
 * What the model can do about a file over `maxFileBytes`, which `read`
 * refuses unread: with `readImages`, a file named as a PNG, JPEG, GIF or
 * WebP image is told to read a smaller copy; any other to read parts of it.
 */
export const fileTooLargeHint = (path: string, readImages: boolean): string =>
  readImages && Option.exists(mediaTypeOf(path), Schema.is(ImageMediaType))
    ? "to see it, make a smaller copy with bash (scaled down or recompressed) and read that"
    : "use grep to find lines in it, or bash (head, tail, sed -n) for parts of it"

/** The images `read`'s view sends with its result: an `Image`'s, once. */
export const readMedia = (result: ReadResult): ReadonlyArray<Media> => Match.valueTags(result, {
  Text: () => [],
  Binary: () => [],
  Image: (read) => [read.image],
  ImageRejected: () => [],
})

/** What the model can do about an image `read` cannot send, by why. */
const rejectedHint: Readonly<Record<AttachmentRejectedReason, string>> = {
  TooLarge: " To see it, make a smaller copy with bash (scaled down or recompressed) and read that.",
  TooManyPixels: " To see it, make a smaller copy with bash (scaled down) and read that.",
  Unreadable: " The file may be damaged or cut short.",
  Empty: "",
  InvalidBase64: "",
  UnsupportedType: "",
  TooMany: "",
  TooLargeTogether: "",
}

export const renderRead = (result: ReadResult): string => Match.valueTags(result, {
  Binary: (binary) => `[${binary.path} is a binary file (${formatBytes(binary.bytes)}${binary.mediaType === null ? "" : `, ${binary.mediaType}`}); it cannot be shown as text.]`,
  Image: (read) => `[Image ${read.path} (${read.image.mediaType}, ${formatBytes(read.image.bytes)}).]`,
  ImageRejected: (read) => `[${read.path} is an image (${read.mediaType}, ${formatBytes(read.bytes)}) that read cannot show: ${read.message}.${rejectedHint[read.reason]}]`,
  Text: (text) => text.totalLines === 0 ? `[${text.path} is empty.]` : [
    text.text,
    ...(text.clipped ? [`[Line ${text.firstLine} is longer than the window; only its start is shown. Use bash (cut, head -c) to see the rest.]`] : []),
    ...(text.lossy ? [`[${text.path} is not valid UTF-8: bytes that are not show as �. edit refuses such a file; change it with bash.]`] : []),
    ...(text.next === null ? [] : [`[Showing lines ${text.firstLine}-${text.lastLine} of ${text.totalLines}. Use offset=${text.next} to continue.]`]),
  ].join("\n"),
})

export const compactRead = (result: ReadResult): string => Match.valueTags(result, {
  Binary: (binary) => `(read ${binary.path}: binary, ${formatBytes(binary.bytes)})`,
  Image: (read) => `(read ${read.path}: ${read.image.mediaType} image, ${formatBytes(read.image.bytes)})`,
  ImageRejected: (read) => `(read ${read.path}: ${read.mediaType} image not shown, ${read.reason})`,
  Text: (text) => `(read ${text.path}: lines ${text.firstLine}-${text.lastLine} of ${text.totalLines})`,
})

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

export const compactLs = (result: LsResult): string => `(listed ${result.path}: ${counted(result.total, "entry", "entries")})`

export const renderFind = (result: FindResult, maxLines: number, maxBytes: number): string => {
  if (result.paths.length === 0) return `No files under ${place(result.path)} match ${result.pattern}.`
  const head = headLines(result.paths, maxLines, maxBytes)
  return [
    ...head.lines,
    ...(head.omitted > 0 ? [`[${counted(head.omitted, "more path", "more paths")} not shown. Narrow the pattern or the path.]`]
      : result.truncated ? [`[Stopped at ${counted(result.paths.length, "path", "paths")}; there are more. Narrow the pattern or the path.]`] : []),
  ].join("\n")
}

export const compactFind = (result: FindResult): string =>
  `(find ${result.pattern} in ${result.path}: ${result.truncated ? `${result.paths.length}+ paths` : counted(result.paths.length, "path", "paths")})`

/** The files grep could not read, one line per reason, each naming at most five of them. */
const unreadableLines = (result: GrepResult): ReadonlyArray<string> =>
  Array.from(new Set(result.unreadable.map((file) => file.reason)), (reason) => {
    const paths = result.unreadable.filter((file) => file.reason === reason).map((file) => file.path)
    const why = reason === "Permission" ? "permission denied" : `a file-system error (${reason})`
    return `[Could not read ${paths.length} file${paths.length === 1 ? "" : "s"}, ${why}: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? `, and ${paths.length - 5} more` : ""}.]`
  })

export const renderGrep = (result: GrepResult, withContext: boolean, maxLines: number, maxBytes: number): string => {
  const skipped = [
    ...(result.skipped === 0 ? [] : [`[${result.skipped} file${result.skipped === 1 ? "" : "s"} skipped: binary, larger than the read limit, or leading outside the workspace.]`]),
    ...unreadableLines(result),
  ]
  if (result.matches === 0) return [`No matches for ${result.pattern} in ${place(result.path)}.`, ...skipped].join("\n")
  const head = headLines(renderSearchLines(result.lines, withContext), maxLines, maxBytes)
  return [
    ...head.lines,
    ...(head.omitted > 0 ? [`[${counted(head.omitted, "more line", "more lines")} not shown. Narrow the pattern or the path.]`] : []),
    ...(result.truncated ? [`[Stopped at ${counted(result.matches, "matching line", "matching lines")}; there are more. Narrow the pattern or the path, or raise limit.]`] : []),
    ...skipped,
  ].join("\n")
}

export const compactGrep = (result: GrepResult): string =>
  `(grep ${result.pattern} in ${result.path}: ${result.truncated ? `${result.matches}+ matching lines` : counted(result.matches, "matching line", "matching lines")} in ${counted(result.files, "file", "files")})`

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
