import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"

/**
 * Materialise `files` into a fresh temp directory, run `use(dir)`, and remove
 * the directory afterwards (even on failure/interrupt — `acquireUseRelease`
 * guarantees the release). Keys are paths relative to the temp root; nested
 * dirs are created. The real `FileSystem`/`Shell` adapters then operate on
 * this dir like any workspace.
 */
export const withTempWorkspace = <A, E, R>(
  files: Record<string, string>,
  use: (dir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = mkdtempSync(join(tmpdir(), "agent-eval-"))
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(dir, rel)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content)
      }
      return dir
    }),
    use,
    (dir) =>
      Effect.sync(() => {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* best-effort cleanup */
        }
      }),
  )

/** Read a file from a temp workspace; returns "" if it's missing. */
export const readWorkspaceFile = (dir: string, rel: string): string => {
  try {
    return readFileSync(join(dir, rel), "utf8")
  } catch {
    return ""
  }
}
