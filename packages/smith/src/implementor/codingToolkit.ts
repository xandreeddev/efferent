import { isAbsolute, join, normalize, relative } from "node:path"
import { Tool, Toolkit } from "@effect/ai"
import { Effect, Option, Schema } from "effect"
import { Failure, FileSystem, Shell } from "@xandreed/engine"
import { discoverSkills, readSkill } from "../skills/skills.js"
import { nativeGlob, nativeGrep } from "./nativeSearch.js"

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
  description:
    "Read one file. Returns {content, truncated} — content over 48k chars is clipped with a marker; page big files with offset/limit. Reads may leave the workspace (dependency sources are fair game).",
  parameters: {
    path: Schema.String.annotations({ description: "Workspace-relative or absolute path." }),
    offset: Schema.optional(Schema.Number.annotations({ description: "1-based first line (default 1)." })),
    limit: Schema.optional(Schema.Number.annotations({ description: "Max lines from offset (default: to end)." })),
  },
  success: Schema.Struct({ content: Schema.String, truncated: Schema.Boolean }),
  failure: Failure,
  failureMode: "return",
})

export const WriteFile = Tool.make("write_file", {
  description:
    "Create or overwrite ONE file inside the workspace (writes outside it are refused). Provide the FULL file body — empty content is refused; use edit_file to blank a file intentionally. Side effect: missing parent directories are created. Returns {written, path}.",
  parameters: {
    path: Schema.String.annotations({ description: "Workspace-relative (or absolute inside the workspace)." }),
    content: Schema.String.annotations({ description: "The complete file body." }),
  },
  success: Schema.Struct({ written: Schema.Boolean, path: Schema.String }),
  failure: Failure,
  failureMode: "return",
})

export const EditFile = Tool.make("edit_file", {
  description:
    'Replace exact text in one workspace file. Provide edits: [{oldText, newText}] (or a single flat oldText/newText pair). Each oldText must match EXACTLY once, whitespace included — include surrounding lines to make it unique. Example: {path: "src/a.ts", oldText: "const x = 1", newText: "const x = 2"}. Returns {edited, path, applied: number of edits applied}.',
  parameters: {
    path: Schema.String.annotations({ description: "Workspace-relative (or absolute inside the workspace)." }),
    edits: Schema.optional(
      Schema.Array(Schema.Struct({ oldText: Schema.String, newText: Schema.String })),
    ),
    oldText: Schema.optional(Schema.String.annotations({ description: "Flat single-edit form: the exact text to replace." })),
    newText: Schema.optional(Schema.String.annotations({ description: "Flat single-edit form: the replacement." })),
  },
  success: Schema.Struct({ edited: Schema.Boolean, path: Schema.String, applied: Schema.Number }),
  failure: Failure,
  failureMode: "return",
})

export const Bash = Tool.make("Bash", {
  description:
    "Run one shell command (bash -c) with cwd = the workspace root. A non-zero exit is a RESULT, not an error: returns {stdout, stderr, exitCode} — read stderr and adapt. Output over 16k chars is clipped with a marker.",
  parameters: {
    command: Schema.String.annotations({ description: "The command line to run." }),
    timeout: Schema.optional(
      Schema.Number.annotations({ description: "Timeout in ms (default 300000 = 5 minutes)." }),
    ),
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
  description:
    'Search file contents with an extended regex (grep -rnE; node_modules and .git excluded). Returns {matches: "path:line:text" lines (first 200), truncated}.',
  parameters: {
    pattern: Schema.String.annotations({ description: "Extended (ERE) regex matched against file contents." }),
    dir: Schema.optional(Schema.String.annotations({ description: 'Directory to search, workspace-relative (default ".").' })),
  },
  success: Schema.Struct({ matches: Schema.String, truncated: Schema.Boolean }),
  failure: Failure,
  failureMode: "return",
})

export const Glob = Tool.make("glob", {
  description:
    "Find files by NAME pattern (find -name) — matches file names, not full paths. Returns {paths (first 200), truncated}.",
  parameters: {
    pattern: Schema.String.annotations({ description: 'A file-name pattern, e.g. "*.ts" or "store*.md".' }),
    dir: Schema.optional(Schema.String.annotations({ description: 'Directory to search under, workspace-relative (default ".").' })),
  },
  success: Schema.Struct({ paths: Schema.Array(Schema.String), truncated: Schema.Boolean }),
  failure: Failure,
  failureMode: "return",
})

export const Ls = Tool.make("ls", {
  description:
    "List one directory's entries (names only, not recursive). Returns {entries}.",
  parameters: {
    path: Schema.optional(Schema.String.annotations({ description: 'Directory, workspace-relative (default ".").' })),
  },
  success: Schema.Struct({ entries: Schema.Array(Schema.String) }),
  failure: Failure,
  failureMode: "return",
})

export const LoadSkill = Tool.make("load_skill", {
  description:
    "Load the FULL instructions of a workspace skill listed under 'Skills available'. Call this BEFORE doing work a skill covers. Returns {name, instructions}.",
  parameters: {
    name: Schema.String.annotations({ description: "The skill's name exactly as listed." }),
  },
  success: Schema.Struct({ name: Schema.String, instructions: Schema.String }),
  failure: Failure,
  failureMode: "return",
})

export const TodoWrite = Tool.make("todo_write", {
  description:
    "Replace your WHOLE task plan for this run (the human watches it live). Send EVERY item each time — this replaces the list, never appends. Statuses: pending | in_progress | done; keep exactly ONE item in_progress. Use it at the start (the plan) and whenever an item's status changes. Returns {count}.",
  parameters: {
    todos: Schema.Array(
      Schema.Struct({
        text: Schema.String.annotations({ description: "One short imperative item." }),
        status: Schema.Literal("pending", "in_progress", "done"),
      }),
    ),
  },
  success: Schema.Struct({ count: Schema.Number }),
  failure: Failure,
  failureMode: "return",
})

/** The full coder kit. */
export const smithCodingToolkit = Toolkit.make(
  ReadFile,
  WriteFile,
  EditFile,
  Bash,
  Grep,
  Glob,
  Ls,
  LoadSkill,
  TodoWrite,
)
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
 * Handlers over the engine's FileSystem + Shell, bound to one workspace.
 * Reads may leave the workspace (dependency sources are fair game); WRITES
 * may not — the cwd-prefix guard is the sandbox.
 */
export interface CodingHandlerHooks {
  /** Best-effort live tap on the coder's Bash output (chunk granularity). */
  readonly onBashChunk?: (chunk: string) => void
}

export const makeSmithCodingHandlers = (cwd: string, hooks: CodingHandlerHooks = {}) =>
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

      // The plan is UI-side state: the TUI derives it from this call's
      // args (tool_start events); the handler just acknowledges.
      todo_write: (params: { todos: ReadonlyArray<unknown> }) =>
        Effect.succeed({ count: params.todos.length }),

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
          const result = yield* shell
            .exec(params.command, {
              cwd,
              timeoutMs: params.timeout ?? DEFAULT_BASH_TIMEOUT_MS,
              ...(hooks.onBashChunk !== undefined ? { onChunk: hooks.onBashChunk } : {}),
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
          // Native (pure-TS over Bun.Glob + reads): no system-grep
          // dependency, deterministic sorted walk, binary files skipped.
          const dir = resolve(params.dir ?? ".")
          const result = yield* nativeGrep(dir, params.pattern)
          const clipped = clipText(result.matches, OUTPUT_CAP_CHARS)
          return { matches: clipped.text, truncated: result.truncated || clipped.truncated }
        }),

      glob: (params: { pattern: string; dir?: string | undefined }) =>
        Effect.gen(function* () {
          const dir = resolve(params.dir ?? ".")
          const result = yield* nativeGlob(dir, params.pattern)
          return { paths: result.paths, truncated: result.truncated }
        }),

      ls: (params: { path?: string | undefined }) =>
        Effect.gen(function* () {
          const entries = yield* fs
            .list(resolve(params.path ?? "."))
            .pipe(Effect.mapError((e) => ({ error: "LsFailed", message: e.message })))
          return { entries }
        }),

      load_skill: (params: { name: string }) =>
        Effect.gen(function* () {
          const body = yield* readSkill(cwd, params.name).pipe(
            Effect.provideService(FileSystem, fs),
          )
          if (Option.isNone(body)) {
            const available = yield* discoverSkills(cwd).pipe(
              Effect.provideService(FileSystem, fs),
            )
            return yield* Effect.fail({
              error: "UnknownSkill",
              message:
                available.length === 0
                  ? `no skill named "${params.name}" — this workspace defines no skills`
                  : `no skill named "${params.name}" — available: ${available.map((s) => s.name).join(", ")}`,
            })
          }
          return { name: params.name, instructions: body.value }
        }),
    })
  })

/** The full coder kit's handler Layer, bound to one workspace. */
export const smithCodingToolkitLayer = (cwd: string) =>
  smithCodingToolkit.toLayer(makeSmithCodingHandlers(cwd))
