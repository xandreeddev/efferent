import { isAbsolute, relative, resolve } from "node:path"
import { Tool, Toolkit } from "@effect/ai"
import { Effect, Schema } from "effect"
import type { Skill } from "../entities/Skill.js"
import { FileSystem } from "../ports/FileSystem.js"
import { Http } from "../ports/Http.js"
import { Shell } from "../ports/Shell.js"

/**
 * The coding tools as an `@effect/ai` Toolkit. Each tool ships explicit
 * `success`/`failure` Structs (Gemini's functionResponse must be an
 * object) with `failureMode: "return"` so a tool failure is handed back
 * to the model as data instead of aborting the turn. Handlers resolve
 * `FileSystem`/`Shell` from context at layer-build time; the runtime
 * `cwd` is bound by `codingToolkitLayer(cwd)`.
 */

const resolvePath = (cwd: string, path: string): string =>
  isAbsolute(path) ? path : resolve(cwd, path)

const displayPath = (cwd: string, path: string): string => {
  const rel = relative(cwd, path)
  return rel.startsWith("..") || rel.length === 0 ? path : rel
}

const stripFrontmatter = (content: string): string => {
  if (!content.startsWith("---")) return content
  const rest = content.slice(3)
  const lfIndex = rest.indexOf("\n")
  if (lfIndex === -1) return content
  const afterFirstFence = rest.slice(lfIndex + 1)
  const closeIndex = afterFirstFence.indexOf("\n---")
  if (closeIndex === -1) return content
  return afterFirstFence.slice(closeIndex + 4).replace(/^\n+/, "")
}

const applyEditsToContent = (
  content: string,
  edits: ReadonlyArray<{ oldText: string; newText: string }>,
): { result: string; error?: string } => {
  let current = content
  for (let i = 0; i < edits.length; i++) {
    const { oldText, newText } = edits[i]!
    const idx = current.indexOf(oldText)
    if (idx === -1) {
      return {
        result: current,
        error: `edit ${i + 1} of ${edits.length}: oldText not found in file`,
      }
    }
    const next = current.indexOf(oldText, idx + oldText.length)
    if (next !== -1) {
      return {
        result: current,
        error: `edit ${i + 1} of ${edits.length}: oldText is ambiguous (matches multiple times); include more surrounding context`,
      }
    }
    current = current.slice(0, idx) + newText + current.slice(idx + oldText.length)
  }
  return { result: current }
}

/**
 * Minimal unified diff: trim the common prefix + suffix, then report only
 * the changed span between them as removed/added lines. Far better than
 * dumping the whole file when one line changes (and keeps the model's view
 * tight too). Multi-region edits over-report the gap between the first and
 * last change — acceptable; a full LCS is a later refinement.
 */
export const unifiedDiff = (before: string, after: string, path: string): string => {
  const a = before.split("\n")
  const b = after.split("\n")
  let start = 0
  const maxStart = Math.min(a.length, b.length)
  while (start < maxStart && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  const removed = a.slice(start, endA + 1)
  const added = b.slice(start, endB + 1)
  if (removed.length === 0 && added.length === 0) return ""
  const lines: string[] = [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
  ]
  for (const l of removed) lines.push(`-${l}`)
  for (const l of added) lines.push(`+${l}`)
  return lines.join("\n")
}

const formatReadOutput = (
  content: string,
  startLine: number,
  truncated: boolean,
  totalLines: number,
): string => {
  const lines = content.split("\n")
  const numbered = lines
    .map((line, i) => `${String(startLine + i).padStart(5, " ")}\t${line}`)
    .join("\n")
  if (truncated) {
    return `${numbered}\n... (truncated; file has ${totalLines} lines total)`
  }
  return numbered
}

const truncateOutput = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}\n... (truncated, ${s.length - max} more bytes)`

/** Reduce HTML to readable text — drop script/style/tags, decode common entities. */
const htmlToText = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()

// ---- shared failure shape ----

const Failure = Schema.Struct({
  error: Schema.String,
  message: Schema.optional(Schema.String),
})
type Failure = typeof Failure.Type

const toFailure = (e: unknown): Failure => {
  const tag =
    typeof e === "object" && e !== null && "_tag" in e
      ? String((e as { _tag: unknown })._tag)
      : "Error"
  const message =
    typeof e === "object" && e !== null
      ? String(
          (e as { message?: unknown }).message ??
            (e as { path?: unknown }).path ??
            JSON.stringify(e),
        )
      : String(e)
  return { error: tag, message }
}

// ---- tool definitions ----

export const ReadFile = Tool.make("read_file", {
  description:
    "Read a file's contents with line numbers. Use offset/limit to page through large files.",
  parameters: {
    path: Schema.String.annotations({
      description: "Path to the file (relative to cwd, or absolute).",
    }),
    offset: Schema.optional(
      Schema.Number.annotations({ description: "1-indexed start line." }),
    ),
    limit: Schema.optional(
      Schema.Number.annotations({ description: "Max lines to return." }),
    ),
  },
  success: Schema.Struct({
    path: Schema.String,
    content: Schema.String,
    totalLines: Schema.Number,
    truncated: Schema.Boolean,
  }),
  failure: Failure,
  failureMode: "return",
})

export const WriteFile = Tool.make("write_file", {
  description:
    "Create or fully replace a file. Use 'edit_file' instead for targeted in-place edits to existing files.",
  parameters: {
    path: Schema.String.annotations({
      description: "Path to the file (relative to cwd, or absolute).",
    }),
    content: Schema.String.annotations({
      description: "Full content to write. Overwrites any existing file.",
    }),
  },
  success: Schema.Struct({ path: Schema.String, bytes: Schema.Number }),
  failure: Failure,
  failureMode: "return",
})

export const EditFile = Tool.make("edit_file", {
  description:
    "Apply targeted substring edits to a file. Each edit's oldText must match exactly once in the current file content.",
  parameters: {
    path: Schema.String.annotations({ description: "Path to the file to edit." }),
    edits: Schema.Array(
      Schema.Struct({
        oldText: Schema.String.annotations({
          description:
            "Exact substring to find (whitespace and indentation included). Must be unique in the file.",
        }),
        newText: Schema.String.annotations({ description: "Replacement text." }),
      }),
    ).annotations({
      description:
        "One or more substring edits, applied in order. Each oldText must match exactly once.",
    }),
  },
  success: Schema.Struct({
    path: Schema.String,
    editsApplied: Schema.Number,
    diff: Schema.String,
  }),
  failure: Failure,
  failureMode: "return",
})

export const Bash = Tool.make("bash", {
  description:
    "Execute a shell command in the workspace. Use for git, build, test, install, and other operations not covered by the other tools.",
  parameters: {
    command: Schema.String.annotations({
      description: "Shell command. Runs via 'bash -c' in the workspace cwd.",
    }),
    timeout: Schema.optional(
      Schema.Number.annotations({
        description: "Timeout in milliseconds. Defaults to 60000.",
      }),
    ),
  },
  success: Schema.Struct({
    exitCode: Schema.Number,
    stdout: Schema.String,
    stderr: Schema.String,
    durationMs: Schema.Number,
    timedOut: Schema.Boolean,
  }),
  failure: Failure,
  failureMode: "return",
})

export const Grep = Tool.make("grep", {
  description:
    "Search for a regex pattern across files. Returns matching lines with file:line:text. Respects .gitignore.",
  parameters: {
    pattern: Schema.String.annotations({
      description: "Regex to search for. Passed to GNU grep as ERE (-E).",
    }),
    dir: Schema.optional(
      Schema.String.annotations({
        description: "Directory to search in. Defaults to cwd.",
      }),
    ),
    flags: Schema.optional(
      Schema.String.annotations({
        description:
          "Extra grep flags (e.g. '-i' for case-insensitive). -rnE are always set.",
      }),
    ),
    context: Schema.optional(
      Schema.Number.annotations({
        description: "Lines of surrounding context to include per match.",
      }),
    ),
  },
  success: Schema.Struct({
    dir: Schema.String,
    pattern: Schema.String,
    output: Schema.String,
    exitCode: Schema.Number,
  }),
  failure: Failure,
  failureMode: "return",
})

export const Glob = Tool.make("glob", {
  description:
    "Find files matching a glob pattern (e.g. '**/*.ts'). Respects .gitignore. Returns relative paths.",
  parameters: {
    pattern: Schema.String.annotations({
      description: "Glob pattern (e.g. '**/*.ts'). Respects .gitignore.",
    }),
    dir: Schema.optional(
      Schema.String.annotations({
        description: "Directory to glob in. Defaults to cwd.",
      }),
    ),
  },
  success: Schema.Struct({
    dir: Schema.String,
    pattern: Schema.String,
    matches: Schema.Array(Schema.String),
    truncated: Schema.Boolean,
    total: Schema.Number,
  }),
  failure: Failure,
  failureMode: "return",
})

export const Ls = Tool.make("ls", {
  description: "List a directory's entries. Use recursive: true to descend.",
  parameters: {
    path: Schema.optional(
      Schema.String.annotations({
        description: "Directory to list. Defaults to cwd.",
      }),
    ),
    recursive: Schema.optional(
      Schema.Boolean.annotations({ description: "Recurse into subdirectories." }),
    ),
  },
  success: Schema.Struct({
    path: Schema.String,
    entries: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        type: Schema.Literal("file", "dir"),
      }),
    ),
    truncated: Schema.Boolean,
    total: Schema.Number,
  }),
  failure: Failure,
  failureMode: "return",
})

export const ReadSkill = Tool.make("read_skill", {
  description:
    "Read the full body of a named skill (a markdown procedure). Use when a skill's name and one-line description in the prompt suggest it applies to the current task — then follow the steps described in the body.",
  parameters: {
    name: Schema.String.annotations({
      description:
        "Skill name (the value listed in the system prompt's Skills section).",
    }),
  },
  success: Schema.Struct({
    name: Schema.String,
    sourcePath: Schema.String,
    body: Schema.String,
  }),
  failure: Failure,
  failureMode: "return",
})

export const WebFetch = Tool.make("web_fetch", {
  description:
    "Fetch a URL over HTTP(S) and return its content as readable text (HTML is reduced to text). Use for documentation, references, or pages the user links.",
  parameters: {
    url: Schema.String.annotations({
      description: "Absolute http(s) URL to fetch.",
    }),
    maxBytes: Schema.optional(
      Schema.Number.annotations({
        description: "Max bytes of body to read. Defaults to 50000.",
      }),
    ),
  },
  success: Schema.Struct({
    url: Schema.String,
    status: Schema.Number,
    contentType: Schema.String,
    content: Schema.String,
  }),
  failure: Failure,
  failureMode: "return",
})

export const codingToolkit = Toolkit.make(
  ReadFile,
  WriteFile,
  EditFile,
  Bash,
  Grep,
  Glob,
  Ls,
  ReadSkill,
  WebFetch,
)

/**
 * Handler Layer for the coding toolkit, bound to a workspace `cwd` and the
 * discovered `skills`. Requires `FileSystem | Shell`, satisfied at the
 * driver's composition root.
 */
export const codingToolkitLayer = (
  cwd: string,
  skills: ReadonlyArray<Skill> = [],
  options: { readonly allowBash?: boolean } = {},
) =>
  codingToolkit.toLayer(
    Effect.gen(function* () {
      const fs = yield* FileSystem
      const shell = yield* Shell
      const http = yield* Http
      const allowBash = options.allowBash ?? true
      const skillByName = new Map(skills.map((s) => [s.name, s] as const))

      return {
        read_file: ({ path, offset, limit }) =>
          Effect.gen(function* () {
            const abs = resolvePath(cwd, path)
            const result = yield* fs.read(abs, {
              ...(offset !== undefined ? { offset } : {}),
              ...(limit !== undefined ? { limit } : {}),
            })
            return {
              path: displayPath(cwd, abs),
              content: formatReadOutput(
                result.content,
                offset ?? 1,
                result.truncated,
                result.totalLines,
              ),
              totalLines: result.totalLines,
              truncated: result.truncated,
            }
          }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

        write_file: ({ path, content }) =>
          Effect.gen(function* () {
            const abs = resolvePath(cwd, path)
            yield* fs.write(abs, content)
            return {
              path: displayPath(cwd, abs),
              bytes: new TextEncoder().encode(content).byteLength,
            }
          }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

        edit_file: ({ path, edits }) =>
          Effect.gen(function* () {
            const abs = resolvePath(cwd, path)
            const before = yield* fs.read(abs)
            const applied = applyEditsToContent(before.content, edits)
            if (applied.error !== undefined) {
              return yield* Effect.fail({
                error: "EditFailed",
                message: applied.error,
              })
            }
            yield* fs.write(abs, applied.result)
            return {
              path: displayPath(cwd, abs),
              editsApplied: edits.length,
              diff: unifiedDiff(
                before.content,
                applied.result,
                displayPath(cwd, abs),
              ),
            }
          }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

        bash: ({ command, timeout }) =>
          Effect.gen(function* () {
            if (!allowBash) {
              return yield* Effect.fail({
                error: "BashNotAllowed",
                message:
                  "bash execution is disabled in this mode — re-run with --allow-bash to enable",
              })
            }
            const r = yield* shell.exec({
              command,
              cwd,
              timeoutMs: timeout ?? 60_000,
            })
            return {
              exitCode: r.exitCode ?? -1,
              stdout: truncateOutput(r.stdout, 32_000),
              stderr: truncateOutput(r.stderr, 8_000),
              durationMs: r.durationMs,
              timedOut: r.timedOut,
            }
          }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

        grep: ({ pattern, dir, flags, context }) =>
          Effect.gen(function* () {
            const target = dir !== undefined ? resolvePath(cwd, dir) : cwd
            const ctxFlag = context !== undefined ? ` -C ${context}` : ""
            const extra = flags !== undefined ? ` ${flags}` : ""
            const escaped = pattern.replace(/'/g, "'\\''")
            const cmd = `grep -rnE${ctxFlag}${extra} --exclude-dir=.git --exclude-dir=node_modules '${escaped}' ${JSON.stringify(target)} || true`
            const r = yield* shell.exec({ command: cmd, cwd, timeoutMs: 30_000 })
            return {
              dir: displayPath(cwd, target),
              pattern,
              output: truncateOutput(r.stdout, 32_000),
              exitCode: r.exitCode ?? -1,
            }
          }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

        glob: ({ pattern, dir }) =>
          Effect.gen(function* () {
            const target = dir !== undefined ? resolvePath(cwd, dir) : cwd
            const matches = yield* fs.glob(pattern, {
              cwd: target,
              respectGitignore: true,
            })
            return {
              dir: displayPath(cwd, target),
              pattern,
              matches: matches.slice(0, 200),
              truncated: matches.length > 200,
              total: matches.length,
            }
          }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

        ls: ({ path, recursive }) =>
          Effect.gen(function* () {
            const target = path !== undefined ? resolvePath(cwd, path) : cwd
            const entries = yield* fs.list(target, {
              ...(recursive !== undefined ? { recursive } : {}),
            })
            return {
              path: displayPath(cwd, target),
              entries: entries.slice(0, 500).map((e) => ({
                path: displayPath(cwd, e.path),
                type: e.type,
              })),
              truncated: entries.length > 500,
              total: entries.length,
            }
          }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

        web_fetch: ({ url, maxBytes }) =>
          Effect.gen(function* () {
            if (!/^https?:\/\//i.test(url)) {
              return yield* Effect.fail({
                error: "InvalidUrl",
                message: "url must be an absolute http:// or https:// URL",
              })
            }
            const cap = maxBytes ?? 50_000
            const res = yield* http.get(url, { maxBytes: cap })
            const text = res.contentType.includes("html")
              ? htmlToText(res.body)
              : res.body
            return {
              url,
              status: res.status,
              contentType: res.contentType,
              content: truncateOutput(text, cap),
            }
          }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

        read_skill: ({ name }) =>
          Effect.gen(function* () {
            const skill = skillByName.get(name)
            if (skill === undefined) {
              return yield* Effect.fail({
                error: "UnknownSkill",
                message: `No skill named '${name}'. Available: ${
                  [...skillByName.keys()].join(", ") || "(none)"
                }`,
              })
            }
            const read = yield* fs.read(skill.sourcePath)
            return {
              name: skill.name,
              sourcePath: skill.sourcePath,
              body: stripFrontmatter(read.content),
            }
          }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),
      }
    }),
  )
