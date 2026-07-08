import { Effect } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { WorkspacePath } from "../domain/Brands.js"
import { WorkspaceError } from "../domain/Errors.js"
import type { Workspace } from "../ports/Gate.js"

const SKIPPED_DIRS = new Set(["node_modules", ".git", ".foundry"])

const isSkipped = (relPath: string): boolean =>
  relPath.split("/").some((segment) => SKIPPED_DIRS.has(segment))

/** Walk one directory level; unreadable entries are SKIPPED, never fatal —
 *  a 0700 pg-data dir or a root-owned file must not kill a forge run that
 *  already did its work (live-caught: EACCES at snapshot time threw away a
 *  full implementation attempt). Skipped dirs are PRUNED before descent so
 *  node_modules/.git are never even read. */
const walk = async (rootDir: string, dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .then((found) => found, () => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const abs = path.join(dir, entry.name)
      const rel = path.relative(rootDir, abs).split(path.sep).join("/")
      if (isSkipped(rel)) return []
      if (entry.isDirectory()) return walk(rootDir, abs)
      if (entry.isFile()) return [rel]
      return []
    }),
  )
  return nested.flat()
}

/** The second `WorkspacePath` mint point (the first is the AST walk). */
export const snapshotWorkspace = (rootDir: string): Effect.Effect<Workspace, WorkspaceError> =>
  Effect.tryPromise({
    try: () => walk(rootDir, rootDir),
    catch: (cause) => new WorkspaceError({ message: `snapshot of ${rootDir} failed: ${String(cause)}` }),
  }).pipe(
    Effect.map((files) => ({
      rootDir,
      files: [...files].sort().map((rel) => WorkspacePath.make(rel)),
    })),
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
      }).pipe(Effect.ignore),
  )
