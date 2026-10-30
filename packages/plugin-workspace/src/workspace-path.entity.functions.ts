import { Effect, Option, Result } from "effect"
import type { Context, Path } from "effect"
import { compileGlob, FileSystem, FsError, SessionEnvironment } from "@xandreed/core"
import type { Failure, FsReason } from "@xandreed/core"
import type { AllowedRoot, WorkspaceAccessMode, WorkspaceAllowedRoot, WorkspaceRoot, WorkspaceTarget } from "./workspace-path.entity.js"

type Fs = Context.Service.Shape<typeof FileSystem>

/** The workspace a call works in (`WorkspaceRoot`), with the file system and path functions it uses. */
export type WorkspaceAccess = WorkspaceRoot & { readonly fs: Fs; readonly path: Path.Path }

const failure = (error: string, message: string): Failure => ({ error, message })

/** Each `FsReason` (the port's, which hosts and logs keep) as the model reads it: a name that says what is wrong, and what to do. */
const reasons: Readonly<Record<FsReason, (display: string) => Failure>> = {
  NotFound: (display) => failure("NotFound", `${display} does not exist`),
  Exists: (display) => failure("AlreadyExists", `${display} already exists, and the file system would not replace it; give another path`),
  IsDirectory: (display) => failure("IsDirectory", `${display} is a directory; give the path of a file`),
  NotDirectory: (display) => failure("NotDirectory", `${display} is not a directory, or a part of the path before it is a file`),
  NotEmpty: (display) => failure("DirectoryNotEmpty", `${display} is a directory with entries in it; give another path`),
  Permission: (display) => failure("AccessDenied", `permission denied: ${display}`),
  Invalid: (display) => failure("InvalidPath", `${display} is not a path the file system accepts; check it and try again`),
  Io: (display) => failure("FileSystemError", `${display} could not be read or written (a file-system error); try again, or give another path`),
}

/**
 * A file-system failure as the model reads it: what went wrong with the path
 * it gave, in words, by the failure's reason. Never the backend's message,
 * which names host paths the model never gave.
 */
export const fsFailure = (display: string) => (error: FsError): Failure => reasons[error.reason](display)

/** Why the workspace directory cannot be opened, in words, by the file system's reason. */
const unopenable: Readonly<Record<FsReason, string>> = {
  NotFound: "does not exist",
  NotDirectory: "is not a directory",
  Permission: "cannot be opened for lack of permission",
  Invalid: "is not a path the file system accepts",
  Exists: "cannot be opened because of a file-system error",
  IsDirectory: "cannot be opened because of a file-system error",
  NotEmpty: "cannot be opened because of a file-system error",
  Io: "cannot be opened because of a file-system error",
}

/** The workspace directory cannot be opened: why, in words, never the reason's name or the backend's message (it names the host's path). */
export const workspaceMissing = (reason: FsReason): Failure =>
  failure("WorkspaceMissing", `the workspace directory ${unopenable[reason]}, so no workspace tool can run in this session; tell the user`)

/** Whether `path` is `root` or below it. */
export const isWithin = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)

/**
 * Open the workspace of the call: `SessionEnvironment.workspace` made
 * absolute (against the process's directory) and resolved by the file
 * system; one that cannot be resolved fails with `WorkspaceMissing`.
 * Extra roots are resolved against it for this call. An extra root that
 * cannot be opened as a directory is logged and left out.
 */
export const openWorkspace = Effect.fnUntraced(function* (path: Path.Path, options: {
  readonly roots: ReadonlyArray<WorkspaceAllowedRoot>
  readonly workspaceAccess: WorkspaceAccessMode
} = { roots: [], workspaceAccess: "write" }): Effect.fn.Return<WorkspaceAccess, Failure, FileSystem | SessionEnvironment> {
  const fs = yield* FileSystem
  const { workspace } = yield* SessionEnvironment
  const lexicalRoot = path.resolve(workspace)
  // The reason only: the file system's message names the host's path.
  const root = yield* fs.realPath(lexicalRoot).pipe(Effect.mapError((error) => workspaceMissing(error.reason)))
  const extra = yield* Effect.forEach(options.roots, (allowed) => {
    const lexicalRoot = path.resolve(root, allowed.path)
    return fs.realPath(lexicalRoot).pipe(
      Effect.flatMap((root) => fs.stat(root).pipe(Effect.flatMap((info) => info.kind === "directory"
        ? Effect.succeed(Option.some<AllowedRoot>({ root, lexicalRoot, access: allowed.access }))
        : Effect.logWarning("an extra workspace root is not a directory", { path: allowed.path }).pipe(Effect.as(Option.none<AllowedRoot>()))))),
      Effect.catch((error) => Effect.logWarning("an extra workspace root could not be opened", { path: allowed.path, reason: error.reason }).pipe(Effect.as(Option.none<AllowedRoot>()))),
    )
  }, { concurrency: 1 })
  return { fs, path, root, lexicalRoot, roots: [{ root, lexicalRoot, access: options.workspaceAccess }, ...extra.flatMap(Option.toArray)] }
})

/** Whether a real path is inside any root the file tools may read. */
export const withinAnyRoot = (access: WorkspaceAccess, path: string): boolean => access.roots.some((root) => isWithin(root.root, path))

/** The most specific real root controls access; a later explicit root wins an equal-path tie. */
const rootOf = (access: WorkspaceAccess, path: string): Option.Option<AllowedRoot> => access.roots.reduce<Option.Option<AllowedRoot>>((selected, candidate) =>
  isWithin(candidate.root, path) && Option.match(selected, { onNone: () => true, onSome: (current) => candidate.root.length >= current.root.length })
    ? Option.some(candidate) : selected, Option.none())

/** How a path appears to the model: relative to the root (`.` for the root itself), or absolute outside it. */
export const displayOf = (access: WorkspaceAccess, absolute: string): string => {
  const base = isWithin(access.root, absolute) ? access.root : isWithin(access.lexicalRoot, absolute) ? access.lexicalRoot : undefined
  if (base === undefined) return absolute
  const relative = access.path.relative(base, absolute)
  return relative === "" ? "." : relative
}

/**
 * Where a path really is: its `realPath`, or, for a path that does not
 * exist yet, the real path of its nearest existing ancestor followed by the
 * missing names. A link on the way whose target is missing is refused
 * (`BrokenSymlink`): what it would create is not where the path says.
 */
const canonicalOf = (access: WorkspaceAccess, target: string, display: string): Effect.Effect<string, Failure> => access.fs.realPath(target).pipe(
  Effect.catch((error) => {
    const parent = access.path.dirname(target)
    if (error.reason !== "NotFound" || parent === target) return Effect.fail(fsFailure(display)(error))
    return access.fs.stat(target, { followSymlinks: false }).pipe(Effect.matchEffect({
      onSuccess: () => Effect.fail(failure("BrokenSymlink", `${display}: it is a symbolic link to something that does not exist`)),
      onFailure: (missing) => missing.reason === "NotFound"
        ? canonicalOf(access, parent, display).pipe(Effect.map((dir) => access.path.join(dir, access.path.basename(target))))
        : Effect.fail(fsFailure(display)(missing)),
    }))
  }),
)

/**
 * Resolve a path a tool was given: relative to the workspace root, or
 * absolute. With `confine`, a path written outside every allowed root is refused
 * before anything is read, and so is one whose real location (links
 * resolved, through the nearest existing ancestor) is outside all roots
 * (`OutsideWorkspace`). A write into a read root fails with `ReadOnly`;
 * the most specific real root decides access. With confinement off these
 * restrictions are disabled. This is a guardrail against mistakes, not a
 * sandbox: what a path names can change between this check and its use.
 */
export const resolveTarget = Effect.fnUntraced(function* (access: WorkspaceAccess, input: string, options: { readonly confine: boolean; readonly intent?: WorkspaceAccessMode }): Effect.fn.Return<WorkspaceTarget, Failure> {
  const lexical = access.path.resolve(access.root, input.length === 0 ? "." : input)
  const display = displayOf(access, lexical)
  const inside = (path: string) => access.roots.some((root) => isWithin(root.root, path) || isWithin(root.lexicalRoot, path))
  const extras = access.roots.slice(1).map((root) => displayOf(access, root.root))
  if (options.confine && !inside(lexical)) {
    return yield* Effect.fail(failure("OutsideWorkspace", extras.length === 0
      ? `${input} is outside the workspace; use a path under its root`
      : `${input} is outside the workspace and its allowed roots (${extras.join(", ")}); use a path under one of them`))
  }
  const path = yield* canonicalOf(access, lexical, display)
  if (options.confine && !withinAnyRoot(access, path)) {
    return yield* Effect.fail(failure("OutsideWorkspace", extras.length === 0
      ? `${display} leads outside the workspace through a symbolic link`
      : `${display} leads outside the workspace and its allowed roots (${extras.join(", ")}) through a symbolic link`))
  }
  const allowed = rootOf(access, path)
  if (options.confine && options.intent === "write" && Option.exists(allowed, (root) => root.access === "read")) {
    const root = Option.getOrThrow(allowed)
    const place = root.root === access.root ? "the workspace root" : displayOf(access, root.root)
    return yield* Effect.fail(failure("ReadOnly", `${display} is under ${place}, which the workspace tools may read but not change`))
  }
  return { path, display }
})

/** A compiled `protect` glob: the pattern, and whether a path relative to the root matches it. */
export interface ProtectRule {
  readonly glob: string
  readonly matches: (relative: string) => boolean
}

/** Compile `protect` globs (dot entries included); fails with the first pattern that does not compile. */
export const compileProtect = (globs: ReadonlyArray<string>): Result.Result<ReadonlyArray<ProtectRule>, string> =>
  Result.all(globs.map((glob) => Result.mapError(Result.map(compileGlob(glob, { dot: true }), (matcher): ProtectRule => ({ glob, matches: matcher.matches })),
    (reason) => `protect glob ${glob} is not usable: ${reason}`)))

/** A glob's segments, without the empty and `.` ones `compileGlob` ignores. */
const segmentsOf = (glob: string): ReadonlyArray<string> => glob.split("/").filter((segment) => segment.length > 0 && segment !== ".")

/** Whether a segment's braces close within it (a `{a/b,c}` spans segments, and cannot be matched one segment at a time). */
const ownBraces = (segment: string): boolean => (segment.match(/\{/g) ?? []).length === (segment.match(/\}/g) ?? []).length

/**
 * What is left of a path glob's segments once its leading ones have matched
 * the directory names `names`: globs relative to below that directory. A
 * `**` may take none, some or all of the names, so there can be several;
 * none when the glob cannot reach below the directory, or names it (or a
 * directory above it).
 */
const remainderBelow = (pattern: ReadonlyArray<string>, names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const [head, ...rest] = pattern
  const [name, ...below] = names
  if (name === undefined) return pattern.length === 0 ? [] : [`./${pattern.join("/")}`]
  if (head === undefined) return []
  if (head === "**") return [`./${pattern.join("/")}`, ...names.flatMap((_, at) => remainderBelow(rest, names.slice(at)))]
  return Result.match(compileGlob(head, { dot: true }), {
    onFailure: () => [],
    onSuccess: (segment) => segment.matches(name) ? remainderBelow(rest, below) : [],
  })
}

/**
 * The `exclude` globs as a walk from a directory must be given them, the
 * directory written relative to the root (`""` for the root; none when it
 * is outside the workspace). A name (no `/`) applies at any depth, so it is
 * kept. A path is relative to the root, and the walk matches it against
 * paths relative to where it starts: its leading segments are matched
 * against the directory's names and what is left is kept, anchored there
 * with `./`. A path that cannot reach below the directory, or that names
 * the directory or one above it (the walk was asked to go there), is
 * dropped, and so is every path when the directory is outside the
 * workspace. A path whose braces span segments is kept as it is.
 */
export const excludesBelow = (excludes: ReadonlyArray<string>, directory: Option.Option<string>): ReadonlyArray<string> => [...new Set(excludes.flatMap((glob) => {
  if (!glob.includes("/")) return [glob]
  return Option.match(directory, {
    onNone: () => [],
    onSome: (relative) => {
      const names = segmentsOf(relative)
      const pattern = segmentsOf(glob)
      return names.length === 0 || !pattern.every(ownBraces) ? [glob] : remainderBelow(pattern, names)
    },
  })
}))]

/**
 * Refuse a write to a protected path: the path as written and where it
 * really is are both checked, relative to the root, against every rule.
 */
export const checkWritable = (access: WorkspaceAccess, target: WorkspaceTarget, rules: ReadonlyArray<ProtectRule>): Effect.Effect<void, Failure> => {
  const relatives = [target.display, isWithin(access.root, target.path) ? access.path.relative(access.root, target.path) : ""]
    .filter((relative) => relative.length > 0 && relative !== "." && !relative.startsWith("/") && !relative.startsWith(".."))
  const rule = rules.find((candidate) => relatives.some((relative) => candidate.matches(relative)))
  return rule === undefined ? Effect.void : Effect.fail(failure("Protected", `${target.display} is protected (${rule.glob}); the workspace tools do not change it`))
}
