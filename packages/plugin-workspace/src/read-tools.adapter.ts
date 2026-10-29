import { Tool } from "effect/ai"
import { Effect, Option, Result } from "effect"
import type { Path, RcMap, Semaphore } from "effect"
import { defineTool, Failure } from "@xandreed/core"
import type { RegisteredTool, Subject } from "@xandreed/core"
import { compilePattern, searchText } from "./text-search.entity.functions.js"
import { decodeText, formatBytes, lineWindow, looksBinary, mediaTypeOf } from "./text-window.entity.functions.js"
import { displayOf, excludesBelow, fsFailure, isWithin, openWorkspace, resolveTarget } from "./workspace-path.entity.functions.js"
import type { ProtectRule, WorkspaceAccess } from "./workspace-path.entity.functions.js"
import type { WorkspaceTarget } from "./workspace-path.entity.js"
import { FindResult, GrepResult, LsResult, ReadResult } from "./workspace-tools.entity.js"
import type { GrepLine, GrepUnreadable, WorkspaceToolsConfig } from "./workspace-tools.entity.js"
import { binaryRead, compactFind, fileTooLargeHint, compactGrep, compactLs, compactRead, readMedia, renderFind, renderGrep, renderLs, renderRead, toolDescriptions, toolParameters } from "./workspace-tools.entity.functions.js"

/** What every workspace tool is built with: the configuration, the path functions, the compiled `protect` globs and the per-file write locks. */
export interface WorkspaceToolContext {
  readonly config: WorkspaceToolsConfig
  readonly path: Path.Path
  readonly protect: ReadonlyArray<ProtectRule>
  readonly locks: RcMap.RcMap<string, Semaphore.Semaphore>
}

export const failure = (error: string, message: string): Failure => ({ error, message })

/** The refusal of a path that is neither a regular file nor a directory: reading a pipe, socket or device could wait forever. */
export const notAFile = (display: string, tool: string): Failure =>
  failure("NotAFile", `${display} is not a regular file (a pipe, socket or device); ${tool} works on regular files only, use bash for it`)

/** The `exclude` globs for a walk from `target`: path-shaped ones made relative to it (`excludesBelow`). */
const walkExcludes = (access: WorkspaceAccess, target: WorkspaceTarget, excludes: ReadonlyArray<string>): ReadonlyArray<string> =>
  excludesBelow(excludes, isWithin(access.root, target.path) ? Option.some(access.path.relative(access.root, target.path)) : Option.none())

/** A file the result names, for memory to keep track of; none for a name memory could not store as an id. */
export const fileSubjects = (path: string): ReadonlyArray<Subject> =>
  path.length > 0 && path.trim() === path ? [{ kind: "file", id: path, label: Option.none(), data: Option.none() }] : []

const ReadTool = (config: WorkspaceToolsConfig) =>
  Tool.make("read", { description: toolDescriptions(config).read, parameters: toolParameters(config).read, success: ReadResult, failure: Failure, failureMode: "return" })
const LsTool = (config: WorkspaceToolsConfig) =>
  Tool.make("ls", { description: toolDescriptions(config).ls, parameters: toolParameters(config).ls, success: LsResult, failure: Failure, failureMode: "return" })
const FindTool = (config: WorkspaceToolsConfig) =>
  Tool.make("find", { description: toolDescriptions(config).find, parameters: toolParameters(config).find, success: FindResult, failure: Failure, failureMode: "return" })
const GrepTool = (config: WorkspaceToolsConfig) =>
  Tool.make("grep", { description: toolDescriptions(config).grep, parameters: toolParameters(config).grep, success: GrepResult, failure: Failure, failureMode: "return" })

/** `read`: a window of a text file's lines, an image (`readImages`), or what a binary file is. */
export const readTool = ({ config, path }: WorkspaceToolContext): RegisteredTool => defineTool({
  tool: ReadTool(config),
  handler: (params) => Effect.gen(function* () {
    const access = yield* openWorkspace(path)
    const target = yield* resolveTarget(access, params.path, { confine: config.confine })
    const info = yield* access.fs.stat(target.path).pipe(Effect.mapError(fsFailure(target.display)))
    if (info.kind === "directory") return yield* Effect.fail(failure("IsDirectory", `${target.display} is a directory; use ls to list it`))
    if (info.kind !== "file") return yield* Effect.fail(notAFile(target.display, "read"))
    if (info.size > config.maxFileBytes) {
      return yield* Effect.fail(failure("FileTooLarge", `${target.display} is ${formatBytes(info.size)}, more than the ${formatBytes(config.maxFileBytes)} read loads; ${fileTooLargeHint(target.display, config.readImages)}`))
    }
    const bytes = yield* access.fs.readBytes(target.path).pipe(Effect.mapError(fsFailure(target.display)))
    if (looksBinary(bytes)) return yield* binaryRead(target.display, bytes, config.readImages, Option.getOrNull(mediaTypeOf(target.display)))
    const decoded = decodeText(bytes)
    const window = lineWindow(decoded.text, { offset: params.offset ?? 1, limit: params.limit ?? config.maxLines, maxBytes: config.maxBytes })
    return yield* Result.match(window, {
      onFailure: (total) => Effect.fail(failure("OffsetPastEnd", `${target.display} has ${total} line${total === 1 ? "" : "s"}; offset must be at most ${Math.max(1, total)}`)),
      onSuccess: (lines) => Effect.succeed({
        _tag: "Text" as const, path: target.display, text: lines.lines.join("\n"), firstLine: lines.firstLine, lastLine: lines.lastLine,
        totalLines: lines.totalLines, next: Option.getOrNull(lines.next), clipped: lines.clipped, lossy: decoded.lossy,
      }),
    })
  }),
  view: { version: "1", render: renderRead, compact: compactRead, subjects: (result) => fileSubjects(result.path), media: readMedia },
  annotations: { readOnly: true },
})

/** `ls`: a directory's entries by name, at most `lsEntries` of them. */
export const lsTool = ({ config, path }: WorkspaceToolContext): RegisteredTool => defineTool({
  tool: LsTool(config),
  handler: (params) => Effect.gen(function* () {
    const access = yield* openWorkspace(path)
    const target = yield* resolveTarget(access, params.path ?? ".", { confine: config.confine })
    const entries = yield* access.fs.list(target.path).pipe(Effect.mapError((error) => error.reason === "NotDirectory"
      ? failure("NotDirectory", `${target.display} is not a directory; use read to see a file`) : fsFailure(target.display)(error)))
    const limit = params.limit ?? config.lsEntries
    return { path: target.display, entries: entries.slice(0, limit).map((entry) => ({ name: entry.name, kind: entry.kind })), total: entries.length }
  }),
  view: { version: "1", render: renderLs, compact: compactLs },
  annotations: { readOnly: true },
})

/** `find`: the files under a directory whose path matches a glob, as paths relative to the workspace root. */
export const findTool = ({ config, path }: WorkspaceToolContext): RegisteredTool => defineTool({
  tool: FindTool(config),
  handler: (params) => Effect.gen(function* () {
    const access = yield* openWorkspace(path)
    const target = yield* resolveTarget(access, params.path ?? ".", { confine: config.confine })
    const limit = params.limit ?? config.findResults
    const found = yield* access.fs.glob(params.pattern, { cwd: target.path, exclude: walkExcludes(access, target, config.exclude), dot: true, onlyFiles: true, limit }).pipe(
      Effect.mapError((error) => error.reason === "Invalid" ? failure("InvalidPattern", `${params.pattern}: ${error.message}`) : fsFailure(target.display)(error)))
    return { pattern: params.pattern, path: target.display, paths: found.paths.map((relative) => displayOf(access, access.path.join(target.path, relative))), truncated: found.truncated }
  }),
  view: { version: "1", render: (result) => renderFind(result, config.maxLines, config.maxBytes), compact: compactFind },
  annotations: { readOnly: true },
})

interface Searched {
  readonly lines: ReadonlyArray<GrepLine>
  readonly matches: number
  readonly files: number
  readonly skipped: number
  readonly truncated: boolean
  readonly unreadable: ReadonlyArray<GrepUnreadable>
}

/**
 * `grep`: the lines of the files under a path (or of one file) that match.
 * Files come from a walk that never enters links or excluded names; each is
 * resolved again before it is read and skipped when it leads outside the
 * workspace, is not a regular file, is larger than `maxFileBytes` or is
 * binary; one the file system refuses (permission denied, say) is named in
 * `unreadable` with the reason, not counted as skipped. Lines are cut to `grepLineChars` before matching. Searching a
 * directory, one file gives at most a quarter of the limit, so one large
 * file cannot fill the result.
 */
export const grepTool = ({ config, path }: WorkspaceToolContext): RegisteredTool => defineTool({
  tool: GrepTool(config),
  handler: (params) => Effect.gen(function* () {
    const access = yield* openWorkspace(path)
    const target = yield* resolveTarget(access, params.path ?? ".", { confine: config.confine })
    const pattern = yield* Effect.fromResult(compilePattern(params.pattern, { literal: params.literal ?? false, ignoreCase: params.ignoreCase ?? false }))
    const info = yield* access.fs.stat(target.path).pipe(Effect.mapError(fsFailure(target.display)))
    if (info.kind !== "file" && info.kind !== "directory") return yield* Effect.fail(notAFile(target.display, "grep"))
    const glob = params.glob === undefined ? "**/*" : params.glob.includes("/") ? params.glob : `**/${params.glob}`
    const files = info.kind === "file" ? [{ path: target.path, display: target.display }]
      : yield* access.fs.glob(glob, { cwd: target.path, exclude: walkExcludes(access, target, config.exclude), dot: true, onlyFiles: true }).pipe(
        Effect.map((found) => found.paths.map((relative) => {
          const absolute = access.path.join(target.path, relative)
          return { path: absolute, display: displayOf(access, absolute) }
        })),
        Effect.mapError((error) => error.reason === "Invalid" ? failure("InvalidPattern", `glob ${glob}: ${error.message}`) : fsFailure(target.display)(error)))
    const limit = params.limit ?? config.grepMatches
    const perFile = files.length > 1 ? Math.max(1, Math.ceil(limit / 4)) : limit
    const context = params.context ?? 0
    const skip = (state: Searched): Searched => ({ ...state, skipped: state.skipped + 1 })
    const searched = yield* Effect.reduce(files, (): Searched => ({ lines: [], matches: 0, files: 0, skipped: 0, truncated: false, unreadable: [] }), (state, file) => {
      if (state.matches >= limit) return Effect.succeed({ ...state, truncated: true })
      const read = Effect.gen(function* () {
        const real = yield* access.fs.realPath(file.path)
        if (config.confine && !isWithin(access.root, real)) return Option.none<Uint8Array>()
        const found = yield* access.fs.stat(real)
        if (found.kind !== "file" || found.size > config.maxFileBytes) return Option.none<Uint8Array>()
        const bytes = yield* access.fs.readBytes(real)
        return looksBinary(bytes) ? Option.none<Uint8Array>() : Option.some(bytes)
      })
      return read.pipe(
        Effect.map(Option.match({
          onNone: () => skip(state),
          onSome: (content): Searched => {
            const found = searchText(decodeText(content).text, pattern, { lineChars: config.grepLineChars, context, cap: Math.min(perFile, limit - state.matches) })
            return {
              ...state,
              lines: [...state.lines, ...found.lines.map((line) => ({ path: file.display, ...line }))],
              matches: state.matches + found.matches,
              files: state.files + (found.matches > 0 ? 1 : 0),
              truncated: state.truncated || found.capped,
            }
          },
        })),
        Effect.catch((error) => Effect.succeed({ ...state, unreadable: [...state.unreadable, { path: file.display, reason: error.reason }] })),
      )
    })
    return { pattern: params.pattern, path: target.display, ...searched }
  }),
  view: { version: "1", render: (result, params) => renderGrep(result, (params.context ?? 0) > 0, config.maxLines, config.maxBytes), compact: compactGrep },
  annotations: { readOnly: true },
})
