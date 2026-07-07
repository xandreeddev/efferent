import { dirname, isAbsolute, resolve } from "node:path"
import { Array as Arr, Effect, Option, Order } from "effect"
import { FileSystem } from "../ports/FileSystem.js"
import type { DirEntry } from "../ports/FileSystem.js"

/** `start` → each ancestor → the filesystem root, inclusive, in that order. */
export const ancestorDirs = (start: string): ReadonlyArray<string> =>
  Arr.unfold(Option.some(start), (state: Option.Option<string>) =>
    Option.map(state, (dir) => {
      const parent = dirname(dir)
      return [dir, parent === dir ? Option.none<string>() : Option.some(parent)]
    }),
  )

/**
 * `<ancestor>/<suffix>` for each ancestor (cwd-first — closer-to-cwd shadows
 * farther), then `<homeDir>/<suffix>`, deduped. The shared search path of
 * every workspace asset loader (`loadSkills`/`loadMemory`/`loadAgents`).
 */
export const workspaceSearchPath = (
  cwd: string,
  homeDir: string,
  suffix: string,
): ReadonlyArray<string> =>
  Arr.dedupe([
    ...ancestorDirs(cwd).map((dir) => resolve(dir, suffix)),
    resolve(homeDir, suffix),
  ])

/** First occurrence of each key wins — earlier search-path entries shadow later. */
const firstWins = <A>(items: ReadonlyArray<A>, key: (asset: A) => string): ReadonlyArray<A> => {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export interface MarkdownAssetOptions<A> {
  /** Directories to scan, in shadowing order (earlier wins on name collision). */
  readonly dirs: ReadonlyArray<string>
  /** Log prefix for skipped-file notices (e.g. `"skills"`). */
  readonly logTag: string
  /** The dedupe/sort key. */
  readonly name: (asset: A) => string
  /** Parse one file; `None` skips it silently. */
  readonly parse: (content: string, sourcePath: string) => Option.Option<A>
}

/**
 * The shared body of the workspace `.md` asset loaders: scan each dir for
 * `*.md`, parse, dedupe by name (first wins), sort by name. Failures
 * (missing dirs, unreadable files, malformed frontmatter) are silently
 * skipped so a bad asset file never breaks the agent.
 */
export const loadMarkdownAssets = <A>(
  options: MarkdownAssetOptions<A>,
): Effect.Effect<ReadonlyArray<A>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem

    const readOne = (dir: string, entry: DirEntry): Effect.Effect<Option.Option<A>> => {
      if (entry.type !== "file" || !entry.path.endsWith(".md")) {
        return Effect.succeed(Option.none())
      }
      const absPath = isAbsolute(entry.path) ? entry.path : resolve(dir, entry.path)
      return fs.read(absPath).pipe(
        Effect.map((read) => options.parse(read.content, absPath)),
        Effect.catchAll((e) =>
          Effect.log(`${options.logTag}: skipping ${absPath}: ${e}`).pipe(
            Effect.as(Option.none<A>()),
          ),
        ),
      )
    }

    const perDir = (dir: string): Effect.Effect<ReadonlyArray<A>> =>
      fs.list(dir, { recursive: false }).pipe(
        Effect.catchAll(() => Effect.succeed<ReadonlyArray<DirEntry>>([])),
        Effect.flatMap((entries) => Effect.forEach(entries, (entry) => readOne(dir, entry))),
        Effect.map(Arr.getSomes),
      )

    const nested = yield* Effect.forEach(options.dirs, perDir)
    const deduped = firstWins(nested.flat(), options.name)
    return Arr.sort(deduped, Order.mapInput(Order.string, options.name))
  })
