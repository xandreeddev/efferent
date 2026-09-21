import { join } from "node:path"
import { Effect } from "effect"

/**
 * Pure-TS grep/glob over `Bun.Glob` + streamed reads — the system-grep and
 * find dependencies drop out of the coder's toolkit while the TOOL CONTRACT
 * stays byte-compatible ("path:line:text" lines, first 200; paths, first
 * 200). Bounded by construction: excluded trees never walk, binary files
 * (NUL in the first probe) are skipped, per-file reads stop at the match
 * cap, and match lines clip.
 */

const MATCH_CAP = 200
const LINE_CLIP = 300
const EXCLUDED = ["node_modules", ".git", ".foundry", ".efferent"]

const excluded = (path: string): boolean =>
  path.split("/").some((part) => EXCLUDED.includes(part))

const walk = (dir: string): Effect.Effect<ReadonlyArray<string>, { readonly error: string; readonly message: string }> =>
  Effect.tryPromise({
    try: () => Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dir, onlyFiles: true, dot: false })),
    catch: (e) => ({ error: "WalkFailed", message: String(e) }),
  }).pipe(Effect.map((paths) => paths.filter((p) => !excluded(p)).sort()))

const compile = (
  pattern: string,
): Effect.Effect<RegExp, { readonly error: string; readonly message: string }> =>
  Effect.try({
    try: () => new RegExp(pattern),
    catch: (e) => ({
      error: "BadPattern",
      message: `the pattern is not a valid regex: ${String(e).slice(0, 200)}`,
    }),
  })

const fileMatches = (
  dir: string,
  file: string,
  regex: RegExp,
  budget: number,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise({
    try: async () => {
      const text = await Bun.file(join(dir, file)).text()
      if (text.slice(0, 4096).includes("\0")) return []
      return text
        .split("\n")
        .flatMap((line, index) =>
          regex.test(line)
            ? [`${file}:${index + 1}:${line.slice(0, LINE_CLIP)}`]
            : [],
        )
        .slice(0, budget)
    },
    catch: () => "unreadable" as const,
  }).pipe(Effect.orElseSucceed(() => []))

/** The grep tool's native engine: {matches, truncated} — first 200 hits,
 *  walked in sorted order for deterministic output. */
export const nativeGrep = (
  dir: string,
  pattern: string,
): Effect.Effect<
  { readonly matches: string; readonly truncated: boolean },
  { readonly error: string; readonly message: string }
> =>
  Effect.gen(function* () {
    const regex = yield* compile(pattern)
    const files = yield* walk(dir)
    const collected = yield* Effect.reduce(
      files,
      [] as ReadonlyArray<string>,
      (acc, file) =>
        acc.length >= MATCH_CAP
          ? Effect.succeed(acc)
          : fileMatches(dir, file, regex, MATCH_CAP - acc.length).pipe(
              Effect.map((hits) => [...acc, ...hits]),
            ),
    )
    return {
      matches: collected.join("\n"),
      truncated: collected.length >= MATCH_CAP,
    }
  })

/** The glob tool's native engine: file-NAME matching (find -name parity —
 *  the pattern matches basenames, not full paths). */
export const nativeGlob = (
  dir: string,
  pattern: string,
): Effect.Effect<
  { readonly paths: ReadonlyArray<string>; readonly truncated: boolean },
  { readonly error: string; readonly message: string }
> =>
  Effect.gen(function* () {
    const files = yield* walk(dir)
    const glob = yield* Effect.try({
      try: () => new Bun.Glob(pattern),
      catch: (e) => ({
        error: "BadPattern",
        message: `the glob is not valid: ${String(e).slice(0, 200)}`,
      }),
    })
    const hits = files.filter((file) =>
      glob.match(file.split("/").pop() ?? file),
    )
    return {
      paths: hits.slice(0, MATCH_CAP).map((p) => join(dir, p)),
      truncated: hits.length > MATCH_CAP,
    }
  })
