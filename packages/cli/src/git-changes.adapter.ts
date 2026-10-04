import { HarnessError } from "@xandreed/core"
import { spawnBounded } from "@xandreed/plugin-tools-local"
import type { InspectorRow } from "@xandreed/tui"
import { Effect } from "effect"

/** Read both index and working tree, with paths relative to the selected workspace. */
export const workspaceChanges = (workspace: string): Effect.Effect<ReadonlyArray<InspectorRow>, HarnessError> => {
  const git = (args: ReadonlyArray<string>, allowed = [0]) => spawnBounded(["git", "--no-pager", ...args], workspace, 10_000).pipe(
    Effect.mapError((error) => new HarnessError({ code: "cli.changes", message: error.message })),
    Effect.flatMap((result) => allowed.includes(result.exitCode) ? Effect.succeed(result)
      : Effect.fail(new HarnessError({ code: "cli.changes", message: result.stderr.trim() || `Git exited with code ${result.exitCode}` }))),
  )
  const names = (text: string) => text.split("\0").filter(Boolean)
  const diff = ["diff", "--no-ext-diff", "--no-textconv", "--relative"]
  const section = (title: string, text: string) => text.trim() ? `${title}\n${text}` : ""
  // Verify the workspace before concurrent discovery: outside a repository,
  // git diff can enter --no-index mode and obscure the actual discovery error.
  return git(["rev-parse", "--show-toplevel"]).pipe(Effect.flatMap(() => Effect.all([
    git([...diff, "--cached", "--name-only", "-z", "--", "."]),
    git([...diff, "--name-only", "-z", "--", "."]),
    git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
  ], { concurrency: 3 }).pipe(Effect.flatMap(([index, tree, fresh]) => {
    const staged = new Set(names(index.stdout))
    const working = new Set(names(tree.stdout))
    const untracked = new Set(names(fresh.stdout))
    const paths = [...new Set([...staged, ...working, ...untracked])].sort().slice(0, 200)
    return Effect.forEach(paths, (path) => {
      if (untracked.has(path)) return git(["diff", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", path], [0, 1]).pipe(
        Effect.map((result) => ({ id: path, label: path, detail: "New file", text: result.stdout.slice(0, 50_000) })),
      )
      return Effect.all([
        staged.has(path) ? git([...diff, "--cached", "--", path]).pipe(Effect.map((result) => result.stdout)) : Effect.succeed(""),
        working.has(path) ? git([...diff, "--", path]).pipe(Effect.map((result) => result.stdout)) : Effect.succeed(""),
      ], { concurrency: 2 }).pipe(Effect.map(([indexDiff, treeDiff]) => ({
        id: path, label: path, detail: [staged.has(path) ? "Staged" : "", working.has(path) ? "Working tree" : ""].filter(Boolean).join(" · "),
        text: [section("Staged changes", indexDiff), section("Working tree changes", treeDiff)].filter(Boolean).join("\n\n").slice(0, 50_000),
      })))
    }, { concurrency: 4 })
  }))))
}
