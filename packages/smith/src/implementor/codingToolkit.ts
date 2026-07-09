import { isAbsolute, join, normalize, relative } from "node:path"
import { Tool, Toolkit } from "@effect/ai"
import { Effect, Option, Schema } from "effect"
import { Failure, FileSystem, Shell } from "@xandreed/engine"
import type { SpecDoc } from "@xandreed/engine"

/**
 * The direct coder's toolkit on the NEW LINE — a capable single agent doing
 * agentic engineering, with foundry's gates OUTSIDE it (no fleet, no scope
 * sandbox machinery, no approval judge: the forge loop bounds the work and
 * the gates judge the workspace). Every tool is `failureMode: "return"`, so a
 * failure is data the model corrects in the same run. Writes are confined to
 * the workspace by a cwd-prefix guard in the handlers.
 */

const READ_CAP_CHARS = 48_000
const OUTPUT_CAP_CHARS = 16_000
const DEFAULT_BASH_TIMEOUT_MS = 5 * 60_000

export const ReadFile = Tool.make("read_file", {
  description: "Read a file (workspace-relative or absolute path). Large files are clipped — use offset/limit to page.",
  parameters: {
    path: Schema.String,
    offset: Schema.optional(Schema.Number.annotations({ description: "1-based first line." })),
    limit: Schema.optional(Schema.Number.annotations({ description: "Max lines." })),
  },
  success: Schema.Struct({ content: Schema.String, truncated: Schema.Boolean }),
  failure: Failure,
  failureMode: "return",
})

export const WriteFile = Tool.make("write_file", {
  description: "Create or overwrite one file inside the workspace.",
  parameters: { path: Schema.String, content: Schema.String },
  success: Schema.Struct({ written: Schema.Boolean, path: Schema.String }),
  failure: Failure,
  failureMode: "return",
})

export const EditFile = Tool.make("edit_file", {
  description:
    "Replace exact text in a file. Provide edits: [{oldText, newText}] (or a single flat oldText/newText pair). oldText must match EXACTLY once — include enough surrounding context to be unique.",
  parameters: {
    path: Schema.String,
    edits: Schema.optional(
      Schema.Array(Schema.Struct({ oldText: Schema.String, newText: Schema.String })),
    ),
    oldText: Schema.optional(Schema.String),
    newText: Schema.optional(Schema.String),
  },
  success: Schema.Struct({ edited: Schema.Boolean, path: Schema.String, applied: Schema.Number }),
  failure: Failure,
  failureMode: "return",
})

export const Bash = Tool.make("Bash", {
  description:
    "Run a shell command in the workspace (bash -c). Non-zero exits come back as results with stderr — read and adapt. Default timeout 5 minutes.",
  parameters: {
    command: Schema.String,
    timeout: Schema.optional(Schema.Number.annotations({ description: "Timeout in ms." })),
  },
  success: Schema.Struct({
    stdout: Schema.String,
    stderr: Schema.String,
    exitCode: Schema.Number,
  }),
  failure: Failure,
  failureMode: "return",
})

export const Grep = Tool.make("grep", {
  description: "Search file contents (grep -rnE) under a workspace directory.",
  parameters: {
    pattern: Schema.String,
    dir: Schema.optional(Schema.String.annotations({ description: "Relative dir (default .)." })),
  },
  success: Schema.Struct({ matches: Schema.String, truncated: Schema.Boolean }),
  failure: Failure,
  failureMode: "return",
})

export const Glob = Tool.make("glob", {
  description: "Find files by name pattern (find -name) under the workspace.",
  parameters: {
    pattern: Schema.String.annotations({ description: "e.g. *.ts or store*.md" }),
    dir: Schema.optional(Schema.String),
  },
  success: Schema.Struct({ paths: Schema.Array(Schema.String), truncated: Schema.Boolean }),
  failure: Failure,
  failureMode: "return",
})

export const Ls = Tool.make("ls", {
  description: "List a workspace directory.",
  parameters: { path: Schema.optional(Schema.String) },
  success: Schema.Struct({ entries: Schema.Array(Schema.String) }),
  failure: Failure,
  failureMode: "return",
})

/** The full coder kit. */
export const smithCodingToolkit = Toolkit.make(ReadFile, WriteFile, EditFile, Bash, Grep, Glob, Ls)
/** The refiner's read-only exploration subset. */
export const readOnlyToolkit = Toolkit.make(ReadFile, Grep, Glob, Ls)

const clipText = (s: string, cap: number): { readonly text: string; readonly truncated: boolean } =>
  s.length <= cap
    ? { text: s, truncated: false }
    : { text: `${s.slice(0, cap)}\n[…clipped ${s.length - cap} chars…]`, truncated: true }

interface Edit {
  readonly oldText: string
  readonly newText: string
}

const normalizeEdits = (params: {
  readonly edits?: ReadonlyArray<Edit> | undefined
  readonly oldText?: string | undefined
  readonly newText?: string | undefined
}): ReadonlyArray<Edit> =>
  params.edits !== undefined && params.edits.length > 0
    ? params.edits
    : params.oldText !== undefined && params.newText !== undefined
      ? [{ oldText: params.oldText, newText: params.newText }]
      : []

const occurrences = (haystack: string, needle: string): number =>
  needle.length === 0 ? 0 : haystack.split(needle).length - 1

/**
 * Git subcommands the coder may run freely — the ones that only READ the
 * repository. Everything else touches VCS state (index, HEAD, refs, stash),
 * and the workspace's VCS state belongs to the HUMAN: a live coder ran
 * `git add` mid-port, staging the whole tree — the user's plain `git diff`
 * then showed nothing and the work looked lost. A fail-closed ALLOW-list,
 * not a mutation deny-list: an unknown subcommand is refused with guidance.
 */
const READ_ONLY_GIT: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "blame", "grep",
  "ls-files", "ls-tree", "ls-remote", "cat-file",
  "rev-parse", "rev-list", "describe", "shortlog", "name-rev",
  "merge-base", "for-each-ref", "show-ref", "check-ignore", "check-attr",
  "count-objects", "whatchanged", "reflog", "var", "help", "version",
])

/** The escape hatch: the spec itself may authorize VCS mutation with a
 *  constraints bullet carrying the literal token `allow-git-mutation`. */
export const specAllowsGitMutation = (doc: Option.Option<SpecDoc>): boolean =>
  Option.match(doc, {
    onNone: () => false,
    onSome: (spec) => spec.constraints.some((line) => line.includes("allow-git-mutation")),
  })

/** First non-flag token after `git`, skipping `-C <path>` / `-c <k=v>` pairs. */
const gitSubcommand = (tokens: ReadonlyArray<string>): Option.Option<string> =>
  tokens.reduce<{ readonly skip: boolean; readonly found: Option.Option<string> }>(
    (acc, token) =>
      Option.isSome(acc.found)
        ? acc
        : acc.skip
          ? { skip: false, found: Option.none() }
          : token === "-C" || token === "-c"
            ? { skip: true, found: Option.none() }
            : token.startsWith("-")
              ? acc
              : { skip: false, found: Option.some(token) },
    { skip: false, found: Option.none() },
  ).found

/**
 * The first git invocation in `command` that is NOT read-only, if any. A
 * tripwire against the coder's ORDINARY behavior (it ran plain `git add`),
 * not a shell sandbox: segments are split on separators and scanned for a
 * `git` word — adversarial quoting is out of scope, the gates are the
 * security boundary.
 */
export const gitMutation = (command: string): Option.Option<string> =>
  Option.fromNullable(
    command
      .split(/(?:&&|\|\||[;|&\n()])/)
      .flatMap((segment) => {
        const tokens = segment.trim().split(/\s+/)
        const at = tokens.findIndex((t) => t === "git" || t.endsWith("/git"))
        if (at < 0) return []
        return Option.match(gitSubcommand(tokens.slice(at + 1)), {
          onNone: () => [],
          onSome: (sub) => (READ_ONLY_GIT.has(sub) ? [] : [sub]),
        })
      })[0],
  )

/**
 * Handlers over the engine's FileSystem + Shell, bound to one workspace.
 * Reads may leave the workspace (dependency sources are fair game); WRITES
 * may not — the cwd-prefix guard is the sandbox. Git mutation is refused by
 * default (`specAllowsGitMutation` over the locked doc is the opt-in).
 */
export const makeSmithCodingHandlers = (
  cwd: string,
  git: { readonly allowMutation: boolean } = { allowMutation: false },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const shell = yield* Shell

    const resolve = (path: string): string => (isAbsolute(path) ? path : join(cwd, path))
    const insideWorkspace = (path: string): boolean => {
      const rel = relative(cwd, normalize(resolve(path)))
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
    }
    const writeGuard = (path: string) =>
      insideWorkspace(path)
        ? Effect.void
        : Effect.fail({
            error: "OutsideWorkspace",
            message: `"${path}" is outside the workspace (${cwd}) — writes are confined to it`,
          })

    const readFile = (params: { path: string; offset?: number | undefined; limit?: number | undefined }) =>
      Effect.gen(function* () {
        const content = yield* fs
          .read(resolve(params.path))
          .pipe(Effect.mapError((e) => ({ error: "ReadFailed", message: e.message })))
        const lines = content.split("\n")
        const from = Math.max(0, (params.offset ?? 1) - 1)
        const slice =
          params.offset !== undefined || params.limit !== undefined
            ? lines.slice(from, params.limit !== undefined ? from + params.limit : undefined).join("\n")
            : content
        const clipped = clipText(slice, READ_CAP_CHARS)
        return { content: clipped.text, truncated: clipped.truncated }
      })

    return smithCodingToolkit.of({
      read_file: readFile,

      write_file: (params: { path: string; content: string }) =>
        Effect.gen(function* () {
          yield* writeGuard(params.path)
          // An empty write is (almost) never the intent — and it is the
          // signature of long-context output collapse: a coder at 110k
          // tokens emitted write_file(path, "") five straight turns
          // (live-caught on a whole-tree port). Failure-as-data turns the
          // degenerate loop into a corrective signal the model can act on.
          if (params.content.length === 0) {
            return yield* Effect.fail({
              error: "EmptyContent",
              message: `refusing to write an EMPTY ${params.path} — provide the full file body (use edit_file to blank a file intentionally)`,
            })
          }
          const target = resolve(params.path)
          const dir = target.split("/").slice(0, -1).join("/")
          yield* fs.mkdir(dir).pipe(Effect.catchAll(() => Effect.void))
          yield* fs
            .write(target, params.content)
            .pipe(Effect.mapError((e) => ({ error: "WriteFailed", message: e.message })))
          return { written: true, path: params.path }
        }),

      edit_file: (params: {
        path: string
        edits?: ReadonlyArray<Edit> | undefined
        oldText?: string | undefined
        newText?: string | undefined
      }) =>
        Effect.gen(function* () {
          yield* writeGuard(params.path)
          const edits = normalizeEdits(params)
          if (edits.length === 0) {
            return yield* Effect.fail({
              error: "EditFailed",
              message: "no edits given — pass edits:[{oldText,newText}] or a flat oldText/newText pair",
            })
          }
          const target = resolve(params.path)
          const original = yield* fs
            .read(target)
            .pipe(Effect.mapError((e) => ({ error: "ReadFailed", message: e.message })))
          const final = yield* Effect.reduce(edits, original, (content, edit, index) => {
            const count = occurrences(content, edit.oldText)
            if (count === 0) {
              return Effect.fail({
                error: "EditFailed",
                message: `edit ${index}: oldText not found in ${params.path} — re-read the file; the text must match exactly (whitespace included)`,
              })
            }
            if (count > 1) {
              return Effect.fail({
                error: "EditFailed",
                message: `edit ${index}: oldText matches ${count} times in ${params.path} — include more surrounding context to make it unique`,
              })
            }
            return Effect.succeed(content.replace(edit.oldText, edit.newText))
          })
          yield* fs
            .write(target, final)
            .pipe(Effect.mapError((e) => ({ error: "WriteFailed", message: e.message })))
          return { edited: true, path: params.path, applied: edits.length }
        }),

      Bash: (params: { command: string; timeout?: number | undefined }) =>
        Effect.gen(function* () {
          const offender = git.allowMutation ? Option.none<string>() : gitMutation(params.command)
          if (Option.isSome(offender)) {
            return yield* Effect.fail({
              error: "GitMutationRefused",
              message: `refusing \`git ${offender.value}\` — the workspace's VCS state (index, HEAD, refs, stash) belongs to the HUMAN; read-only git (status/log/diff/show/blame) is fine. Do the work with the file tools and leave staging/committing to the user (a spec may opt in with a constraints bullet containing "allow-git-mutation").`,
            })
          }
          const result = yield* shell
            .exec(params.command, {
              cwd,
              timeoutMs: params.timeout ?? DEFAULT_BASH_TIMEOUT_MS,
            })
            .pipe(Effect.mapError((e) => ({ error: "BashFailed", message: e.message })))
          return {
            stdout: clipText(result.stdout, OUTPUT_CAP_CHARS).text,
            stderr: clipText(result.stderr, OUTPUT_CAP_CHARS).text,
            exitCode: result.exitCode,
          }
        }),

      grep: (params: { pattern: string; dir?: string | undefined }) =>
        Effect.gen(function* () {
          const dir = resolve(params.dir ?? ".")
          const result = yield* shell
            .exec(
              `grep -rnE --exclude-dir=node_modules --exclude-dir=.git -- ${JSON.stringify(params.pattern)} ${JSON.stringify(dir)} | head -200`,
              { cwd },
            )
            .pipe(Effect.mapError((e) => ({ error: "GrepFailed", message: e.message })))
          const clipped = clipText(result.stdout, OUTPUT_CAP_CHARS)
          return { matches: clipped.text, truncated: clipped.truncated }
        }),

      glob: (params: { pattern: string; dir?: string | undefined }) =>
        Effect.gen(function* () {
          const dir = resolve(params.dir ?? ".")
          const result = yield* shell
            .exec(
              `find ${JSON.stringify(dir)} -name ${JSON.stringify(params.pattern)} -not -path "*/node_modules/*" -not -path "*/.git/*" | head -200`,
              { cwd },
            )
            .pipe(Effect.mapError((e) => ({ error: "GlobFailed", message: e.message })))
          const paths = result.stdout.split("\n").filter((line) => line.length > 0)
          return { paths, truncated: paths.length >= 200 }
        }),

      ls: (params: { path?: string | undefined }) =>
        Effect.gen(function* () {
          const entries = yield* fs
            .list(resolve(params.path ?? "."))
            .pipe(Effect.mapError((e) => ({ error: "LsFailed", message: e.message })))
          return { entries }
        }),
    })
  })

/** The full coder kit's handler Layer, bound to one workspace. */
export const smithCodingToolkitLayer = (cwd: string) =>
  smithCodingToolkit.toLayer(makeSmithCodingHandlers(cwd))
