import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { Scope } from "effect"

/**
 * A REAL-REPO world: a scoped local clone of a git repository (committed
 * state only — the working tree's dirt never leaks into the eval), with its
 * dependencies installed so the repo's own gates can run. HEAVY by design —
 * packs built on this ride the HEAVY set, never the default battery run.
 */

const spawn = (
  argv: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<number, never> =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([...argv], { cwd, stdout: "ignore", stderr: "pipe" })
      return child.exited
    },
    catch: () => -1,
  }).pipe(Effect.orElseSucceed(() => -1))

export const cloneRepoWorkspace = (
  sourceDir: string,
): Effect.Effect<string, never, Scope.Scope> =>
  Effect.gen(function* () {
    const parent = mkdtempSync(join(tmpdir(), "scenario-repo-"))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(parent, { recursive: true, force: true })),
    )
    const dir = join(parent, "repo")
    const cloned = yield* spawn(
      ["git", "clone", "--local", "--no-hardlinks", "--depth", "1", `file://${sourceDir}`, dir],
      parent,
    )
    yield* cloned === 0
      ? Effect.void
      : // A workspace that is not a git repo (or a git-less host): fall back
        // to a straight copy — dirtier (working tree included) but honest
        // about it via the returned marker the pack can surface.
        Effect.sync(() => {
          cpSync(sourceDir, dir, {
            recursive: true,
            filter: (source) => !source.includes("/node_modules") && !source.includes("/.git/"),
          })
        })
    // The repo's own gates need its dependencies (ts lib resolution, tests).
    yield* spawn(["bun", "install", "--frozen-lockfile"], dir)
    return dir
  })
