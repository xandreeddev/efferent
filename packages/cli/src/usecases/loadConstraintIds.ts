import { resolve } from "node:path"
import { Effect } from "effect"
import { FileSystem } from "@xandreed/sdk-core"

/**
 * Read the workspace's `.efferent/CONSTRAINTS.md` and return the `[id]` slugs of
 * already-persisted constraints. Used by the self-improving loop's dedup list so
 * the miner doesn't re-propose "use const" when `[use-const]` already exists.
 *
 * Lines look like `- [use-const] (✓0 ✗0) use const not let`; the slug is
 * `use-const`. Missing/empty/unreadable files return `[]` fail-soft.
 */
export const loadConstraintIds = (
  cwd: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const read = yield* fs
      .read(resolve(cwd, ".efferent/CONSTRAINTS.md"))
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
    if (read === undefined) return [] as ReadonlyArray<string>
    const ids = read.content
      .split("\n")
      .map((line) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith("- [")) return undefined
        const close = trimmed.indexOf("]")
        if (close <= 2) return undefined
        return trimmed.slice(3, close)
      })
      .filter((id): id is string => id !== undefined && id.length > 0)
    return ids
  })
