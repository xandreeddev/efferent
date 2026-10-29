import { Array as Arr, Effect, Order } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { WorkspacePath } from "../domain/Brands.js"
import { WorkspaceError } from "../domain/Errors.js"
import type { Workspace, WorkspaceFingerprint } from "../ports/Gate.js"

// __pycache__: cache churn from running a Python suite padded the observed
// filesTouched diff AND the judge's file-list evidence (zig re-forge).
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".foundry", "__pycache__"])

const isSkipped = (relPath: string): boolean =>
  relPath.split("/").some((segment) => SKIPPED_DIRS.has(segment))

/** Directory reads in flight at once, per level of a walk. */
const WALK_CONCURRENCY = 8

/** One directory's entries; an unreadable directory has none (see `walk`). */
const entriesOf = (dir: string) =>
  Effect.tryPromise({ try: () => fs.readdir(dir, { withFileTypes: true }), catch: () => "unreadable" as const }).pipe(
    Effect.tapError(() => Effect.logDebug(`${dir} is unreadable; the walk skips it`)),
    Effect.orElseSucceed(() => []),
  )

const relativeTo = (rootDir: string, abs: string): string => path.relative(rootDir, abs).split(path.sep).join("/")

/** Walk one directory level; unreadable entries are SKIPPED, never fatal —
 *  a 0700 pg-data dir or a root-owned file must not kill a forge run that
 *  already did its work (live-caught: EACCES at snapshot time threw away a
 *  full implementation attempt). Skipped dirs are PRUNED before descent so
 *  node_modules/.git are never even read. */
const walk = (rootDir: string, dir: string): Effect.Effect<ReadonlyArray<string>> =>
  entriesOf(dir).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries,
        (entry): Effect.Effect<ReadonlyArray<string>> => {
          const abs = path.join(dir, entry.name)
          const rel = relativeTo(rootDir, abs)
          if (isSkipped(rel)) return Effect.succeed([])
          if (entry.isDirectory()) return walk(rootDir, abs)
          return Effect.succeed(entry.isFile() ? [rel] : [])
        },
        { concurrency: WALK_CONCURRENCY },
      ),
    ),
    Effect.map((nested) => nested.flat()),
  )

/** The second `WorkspacePath` mint point (the first is the AST walk). */
export const snapshotWorkspace = (rootDir: string): Effect.Effect<Workspace, WorkspaceError> =>
  walk(rootDir, rootDir).pipe(
    Effect.map((files) => ({
      rootDir,
      files: Arr.sort(files, Order.String).map((rel) => WorkspacePath.make(rel)),
    })),
  )

/** Like `walk`, but collects a stat signature per file and PRUNES hidden
 *  directories: they hold infrastructure, not deliverable — toolchains
 *  (`.local`), build caches (`.zig-cache`), harness state (`.efferent`) —
 *  and their churn from a coder's Bash-side builds must never read as
 *  "the implementor changed something". Hidden FILES still count
 *  (`.gitignore`, `.env` are real edits); tool-call writes into hidden
 *  dirs stay visible through the receipt union in the forge loop. */
const walkFingerprint = (
  rootDir: string,
  dir: string,
): Effect.Effect<ReadonlyArray<readonly [string, string]>> =>
  entriesOf(dir).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries,
        (entry): Effect.Effect<ReadonlyArray<readonly [string, string]>> => {
          const abs = path.join(dir, entry.name)
          const rel = relativeTo(rootDir, abs)
          if (isSkipped(rel)) return Effect.succeed([])
          if (entry.isDirectory()) {
            return entry.name.startsWith(".") ? Effect.succeed([]) : walkFingerprint(rootDir, abs)
          }
          if (!entry.isFile()) return Effect.succeed([])
          // A file deleted mid-walk is simply absent — same tolerance as `walk`.
          return Effect.tryPromise({ try: () => fs.stat(abs), catch: () => "absent" as const }).pipe(
            Effect.map((stat) => [[rel, `${stat.size}:${stat.mtimeMs}`] as const]),
            Effect.tapError(() => Effect.logDebug(`${rel} went away during the walk`)),
            Effect.orElseSucceed(() => []),
          )
        },
        { concurrency: WALK_CONCURRENCY },
      ),
    ),
    Effect.map((nested) => nested.flat()),
  )

/** The forge loop's movement oracle — taken before and after each implement
 *  call; `diffFingerprints` of the pair is what the attempt actually did. */
export const fingerprintWorkspace = (
  rootDir: string,
): Effect.Effect<WorkspaceFingerprint, WorkspaceError> =>
  walkFingerprint(rootDir, rootDir).pipe(
    Effect.map(
      (entries) => new Map(entries.map(([rel, signature]) => [WorkspacePath.make(rel), signature])),
    ),
  )

export const writeWorkspaceFile = (
  rootDir: string,
  relPath: string,
  content: string,
): Effect.Effect<void, WorkspaceError> =>
  Effect.tryPromise({
    try: async () => {
      const absolute = path.join(rootDir, relPath)
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, content)
    },
    catch: (cause) =>
      new WorkspaceError({ message: `write of ${relPath} failed: ${String(cause)}` }),
  })

/** A scoped throwaway workspace under `parentDir`, removed on release. */
export const withTempWorkspace = <A, E, R>(
  parentDir: string,
  use: (rootDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | WorkspaceError, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        await fs.mkdir(parentDir, { recursive: true })
        return fs.mkdtemp(path.join(parentDir, "ws-"))
      },
      catch: (cause) =>
        new WorkspaceError({ message: `temp workspace creation failed: ${String(cause)}` }),
    }),
    use,
    (rootDir) =>
      Effect.tryPromise({
        try: () => fs.rm(rootDir, { recursive: true, force: true }),
        catch: (cause) => new WorkspaceError({ message: String(cause) }),
      }).pipe(Effect.ignore({ log: "Warn", message: `the temporary workspace ${rootDir} was not removed` })),
  )
