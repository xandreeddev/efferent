import { cpSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"

/**
 * Fixture plumbing shared by the live batteries: cases are directories under
 * `packages/smith/fixtures/<battery>-golden/`, each seeded into a scoped
 * temp workspace (the smithSpec world-boot pattern) so the code under eval
 * runs against a REAL filesystem — `gatherEvidence`, `snapshotWorkspace`,
 * and the accept-gate probes all take real paths.
 */

/** The case directories (sorted for stable scenario ordering). */
export const listCases = (fixturesDir: string): ReadonlyArray<string> =>
  readdirSync(fixturesDir)
    .filter((entry) => statSync(join(fixturesDir, entry)).isDirectory())
    .sort()

/** Copy a fixture's `workspace/` (or the whole case dir when `sub` is given
 *  differently) into a scoped mkdtemp — released with the scenario. */
export const seedWorkspace = (
  sourceDir: string,
): Effect.Effect<string, never, import("effect").Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = mkdtempSync(join(tmpdir(), "evals-live-"))
      cpSync(sourceDir, dir, { recursive: true })
      return dir
    }),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )
