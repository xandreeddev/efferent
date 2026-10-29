import { Effect, Option } from "effect"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { GateName, RuleId } from "../domain/Brands.js"
import { GateCrash } from "../domain/Errors.js"
import { Finding, SourceLocation } from "../domain/Finding.js"
import type { PrivateTextConfig } from "../domain/Rules.js"
import type { Gate, Workspace } from "../ports/Gate.js"
import { includedBy, toWorkspacePath } from "./astWalk.js"

export const PRIVATE_TEXT_GATE = GateName.make("private-text")

const NO_PRIVATE_TEXT = RuleId.make("quality/no-private-text")

const crash = (message: string): GateCrash => new GateCrash({ gate: PRIVATE_TEXT_GATE, message })

/** `git <args>` in `cwd`: its exit code and standard output. */
const git = (cwd: string, args: ReadonlyArray<string>): Effect.Effect<{ readonly code: number; readonly stdout: string }, GateCrash> =>
  Effect.callback((resume) => {
    execFile("git", [...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => {
      resume(
        error === null
          ? Effect.succeed({ code: 0, stdout })
          : typeof error.code === "number"
            ? Effect.succeed({ code: error.code, stdout })
            : Effect.fail(crash(`cannot run git: ${error.message}`)),
      )
    })
  })

/** Every file git tracks, or would track (untracked and not ignored), workspace-relative. */
const committableFiles = (rootDir: string): Effect.Effect<ReadonlyArray<string>, GateCrash> =>
  git(rootDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).pipe(
    Effect.flatMap(({ code, stdout }) =>
      code === 0
        ? Effect.succeed([...new Set(stdout.split("\0").filter((file) => file.length > 0))])
        : Effect.fail(crash(`${rootDir} is not a git work tree: the private-text gate reads the files git tracks`)),
    ),
  )

/** A regular file's text, as `stat` sees the file; anything else (a
 *  directory, a file deleted but still staged) has none. */
const textOf = (
  file: string,
  stat: (file: string) => Promise<{ readonly isFile: () => boolean }>,
): Effect.Effect<Option.Option<string>, GateCrash> =>
  Effect.tryPromise({ try: () => stat(file), catch: () => "absent" as const }).pipe(
    Effect.map((found) => found.isFile()),
    Effect.tapError(() => Effect.logDebug(`${file} has no file to read`)),
    Effect.orElseSucceed(() => false),
    Effect.flatMap((regular) =>
      regular
        ? Effect.tryPromise({
            try: () => fs.readFile(file, "utf8"),
            catch: (cause) => crash(`cannot read ${file}: ${String(cause)}`),
          }).pipe(Effect.map(Option.some))
        : Effect.succeed(Option.none()),
    ),
  )

/** The denylist's terms with their line numbers; none when there is no
 *  such file (a symlink to one counts: worktrees can share it). */
const denylistTerms = (
  rootDir: string,
  denylist: string,
): Effect.Effect<ReadonlyArray<{ readonly term: string; readonly line: number }>, GateCrash> =>
  textOf(path.join(rootDir, denylist), fs.stat).pipe(
    Effect.map(Option.match({
      onNone: () => [],
      onSome: (text) =>
        text
          .split("\n")
          .map((raw, index) => ({ term: raw.trim(), line: index + 1 }))
          .filter(({ term }) => term.length > 0 && !term.startsWith("#")),
    })),
  )

/** A finding unless git ignores the denylist: committed, it would publish every term it lists. */
const denylistUnignored = (rootDir: string, denylist: string): Effect.Effect<ReadonlyArray<Finding>, GateCrash> =>
  git(rootDir, ["check-ignore", "-q", denylist]).pipe(
    Effect.flatMap(({ code }) =>
      code === 0
        ? Effect.succeed([])
        : code === 1
          ? Effect.succeed([
              new Finding({
                rule: NO_PRIVATE_TEXT,
                severity: "error",
                message: `the denylist ${denylist} is not ignored by git: committed, it would publish every term it lists`,
                location: Option.none(),
                fixHint: Option.some(`add ${denylist} to .gitignore (and untrack it if git tracks it)`),
              }),
            ])
          : Effect.fail(crash(`git check-ignore failed on ${denylist} (exit ${code})`)),
    ),
  )

/** A word boundary that counts letters and digits in any script. */
const WORD = "[\\p{L}\\p{N}_]"

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** `/home/<name>`, `/Users/<name>`, `C:\Users\<name>` (one or two backslashes, as source escapes them); group 1 is the name. */
const HOME_PATH = /(?<![\p{L}\p{N}_.-])(?:\/(?:home|Users)\/|[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))([\p{L}\p{N}._-]+)/gu

interface Pattern {
  readonly regexp: RegExp
  readonly allowed: (match: RegExpMatchArray) => boolean
  readonly message: string
  readonly fixHint: string
}

const scan = (rootDir: string, file: string, text: string, patterns: ReadonlyArray<Pattern>): ReadonlyArray<Finding> =>
  text.split("\n").flatMap((line, index) =>
    patterns.flatMap((pattern) =>
      [...line.matchAll(pattern.regexp)]
        .filter((match) => !pattern.allowed(match))
        .map(
          (match) =>
            new Finding({
              rule: NO_PRIVATE_TEXT,
              severity: "error",
              message: pattern.message,
              location: Option.some(
                new SourceLocation({
                  file: toWorkspacePath(rootDir, path.join(rootDir, file)),
                  line: index + 1,
                  column: (match.index ?? 0) + 1,
                }),
              ),
              fixHint: Option.some(pattern.fixHint),
            }),
        ),
    ),
  )

/**
 * Private text as a GATE: no file git tracks, or would track, may hold an
 * absolute home path (unless the home is one of the profile's
 * placeholders) or a term from the profile's local denylist. The messages
 * never repeat what matched: a CI log is as public as the file.
 */
export const makePrivateTextGate = (config: PrivateTextConfig): Gate => ({
  name: PRIVATE_TEXT_GATE,
  kind: "static",
  deterministic: true,
  run: (workspace: Workspace) =>
    Effect.gen(function* () {
      const rootDir = workspace.rootDir
      const placeholders = new Set(config.placeholders.map((name) => name.toLowerCase()))
      const denylist = Option.toArray(config.denylist)
      const terms = (yield* Effect.forEach(denylist, (file) => denylistTerms(rootDir, file))).flat()
      const unignored = (yield* Effect.forEach(denylist, (file) => denylistUnignored(rootDir, file))).flat()
      const patterns: ReadonlyArray<Pattern> = [
        {
          regexp: HOME_PATH,
          allowed: (match) => placeholders.has((match[1] ?? "").toLowerCase()),
          message: "an absolute home path names a person's home directory",
          fixHint: `write a relative path, \`$HOME\`, or a placeholder home (${config.placeholders.length > 0 ? config.placeholders.join(", ") : "none configured"})`,
        },
        ...terms.map(({ term, line }) => ({
          regexp: new RegExp(`(?<!${WORD})${escapeRegExp(term)}(?!${WORD})`, "giu"),
          allowed: () => false,
          message: `a term from the local denylist (${denylist.join(", ")}, line ${line})`,
          fixHint: "remove it: the denylist names what must never be published",
        })),
      ]
      const files = (yield* committableFiles(rootDir)).filter(
        (file) => !denylist.includes(file) && includedBy(config.include, config.exclude, file),
      )
      const found = yield* Effect.forEach(
        files,
        (file) =>
          textOf(path.join(rootDir, file), fs.lstat).pipe(
            Effect.map(Option.match({ onNone: () => [], onSome: (text) => scan(rootDir, file, text, patterns) })),
          ),
        { concurrency: 16 },
      )
      return [...unignored, ...found.flat()]
    }),
})
