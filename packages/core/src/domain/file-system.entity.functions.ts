import { Chunk, Effect } from "effect"
import { compileGlob } from "../util/glob.js"
import { FsError } from "./file-system.entity.js"
import type { DirEntry, GlobOptions, GlobResult } from "./file-system.entity.js"

const byName = (left: DirEntry, right: DirEntry): number => left.name < right.name ? -1 : left.name > right.name ? 1 : 0

const under = (cwd: string, relative: string): string => relative === "" ? cwd : cwd.endsWith("/") ? `${cwd}${relative}` : `${cwd}/${relative}`

/**
 * A glob as a walk over a directory listing, the one semantics every
 * `FileSystem` backend shares (`fs.glob` differs between runtimes: it
 * cannot list dot entries on Node and follows links on Bun). The walk is
 * depth-first with each directory's entries sorted by name, so the paths
 * come out in that order and a `limit` always keeps the same ones. It never
 * enters a symbolic link, prunes `exclude`d entries before entering them,
 * enters only directories that can hold a match, and stops at `limit + 1`
 * matches to report `truncated`. A directory below `cwd` that cannot be
 * listed (no permission, removed meanwhile) is skipped; `cwd` itself must
 * list. The pattern is relative: an absolute one or one with a `..`
 * segment fails with `Invalid`, as does a pattern (or an `exclude`) that
 * `compileGlob` refuses.
 */
export const walkGlob = (
  list: (dir: string) => Effect.Effect<ReadonlyArray<DirEntry>, FsError>,
  pattern: string,
  options: GlobOptions,
): Effect.Effect<GlobResult, FsError> => Effect.suspend(() => {
  const { cwd } = options
  if (!cwd.startsWith("/")) return Effect.fail(new FsError({ path: cwd, reason: "Invalid", message: "a glob's cwd must be an absolute path" }))
  if (pattern.startsWith("/") || pattern.split("/").includes("..")) {
    return Effect.fail(new FsError({ path: pattern, reason: "Invalid", message: "a glob pattern is relative to its cwd and stays below it (no leading / or .. segment)" }))
  }
  const dot = options.dot ?? false
  const onlyFiles = options.onlyFiles ?? false
  const limit = options.limit ?? Number.POSITIVE_INFINITY
  const full = (found: Chunk.Chunk<string>) => Chunk.size(found) > limit
  const compiled = (glob: string, dotted: boolean) => Effect.mapError(Effect.fromResult(compileGlob(glob, { dot: dotted })),
    (reason) => new FsError({ path: glob, reason: "Invalid", message: `not a usable glob pattern: ${reason}` }))
  return Effect.all({
    matcher: compiled(pattern, dot),
    exclusions: Effect.forEach(options.exclude ?? [], (exclude) => compiled(exclude, true).pipe(Effect.map((matcher) => ({ byPath: exclude.includes("/"), matches: matcher.matches }))), { concurrency: 1 }),
  }, { concurrency: 1 }).pipe(Effect.flatMap(({ matcher, exclusions }) => {
    const excluded = (name: string, path: string) => exclusions.some((exclusion) => exclusion.matches(exclusion.byPath ? path : name))
    const visit = (relative: string, found: Chunk.Chunk<string>): Effect.Effect<Chunk.Chunk<string>, FsError> => list(under(cwd, relative)).pipe(
      Effect.catchIf((error) => relative !== "" && (error.reason === "Permission" || error.reason === "NotFound"), () => Effect.succeed<ReadonlyArray<DirEntry>>([])),
      Effect.flatMap((entries) => Effect.reduce(entries.toSorted(byName), () => found, (sofar, entry) => {
        if (full(sofar)) return Effect.succeed(sofar)
        const path = relative === "" ? entry.name : `${relative}/${entry.name}`
        if (excluded(entry.name, path)) return Effect.succeed(sofar)
        const next = matcher.matches(path) && (!onlyFiles || entry.kind === "file") ? Chunk.append(sofar, path) : sofar
        return entry.kind === "directory" && !full(next) && matcher.descends(path) ? visit(path, next) : Effect.succeed(next)
      })),
    )
    return visit("", Chunk.empty())
  }), Effect.map((found): GlobResult => ({
    paths: Chunk.toReadonlyArray(Chunk.take(found, limit)),
    truncated: full(found),
  })))
})
