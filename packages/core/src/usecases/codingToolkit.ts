import { isAbsolute, relative, resolve, sep } from "node:path"
import { Tool, Toolkit } from "@effect/ai"
import { Effect, Schema } from "effect"
import type { Skill } from "../entities/Skill.js"
import { FileSystem } from "../ports/FileSystem.js"
import { Http } from "../ports/Http.js"
import { Shell } from "../ports/Shell.js"
import { WebSearch as WebSearchPort } from "../ports/WebSearch.js"

/**
 * The coding tools as an `@effect/ai` Toolkit. Each tool ships explicit
 * `success`/`failure` Structs (Gemini's functionResponse must be an
 * object) with `failureMode: "return"` so a tool failure is handed back
 * to the model as data instead of aborting the turn. Handlers resolve
 * `FileSystem`/`Shell` from context at layer-build time; the runtime
 * scope (`rootDir`/`displayRoot`) is bound by `makeCodingHandlers(binding)`.
 */

const resolvePath = (cwd: string, path: string): string =>
  isAbsolute(path) ? path : resolve(cwd, path)

const displayPath = (cwd: string, path: string): string => {
  const rel = relative(cwd, path)
  return rel.startsWith("..") || rel.length === 0 ? path : rel
}

/**
 * True when `path` lives inside `rootDir` (or *is* `rootDir`). Uses
 * `path.sep` so `/foo/bar` isn't considered inside `/foo/bar-other`.
 */
const isWithinScope = (path: string, rootDir: string): boolean => {
  const root = rootDir.endsWith(sep) ? rootDir : rootDir + sep
  return path === rootDir || path.startsWith(root)
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

type DiffOp = { readonly tag: "eq" | "del" | "add"; readonly line: string }

/**
 * Line-level LCS (longest common subsequence) via a flat DP table, then a
 * backtrack into a list of equal/delete/add ops in file order. Pure; no IO.
 */
const diffLines = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): DiffOp[] => {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Int32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * w + j]!, dp[i * w + (j + 1)]!)
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: "eq", line: a[i]! })
      i++
      j++
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + (j + 1)]!) {
      ops.push({ tag: "del", line: a[i]! })
      i++
    } else {
      ops.push({ tag: "add", line: b[j]! })
      j++
    }
  }
  while (i < n) ops.push({ tag: "del", line: a[i++]! })
  while (j < m) ops.push({ tag: "add", line: b[j++]! })
  return ops
}

interface Hunk {
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  readonly lines: string[]
}

/**
 * Group an op list into unified-diff hunks, each padded with up to `context`
 * unchanged lines; change regions separated by ≤ 2·context equal lines merge
 * into one hunk. Emits in file order — fixes the old all-removes-then-adds,
 * single-giant-hunk behaviour for multi-region edits.
 */
const groupHunks = (ops: ReadonlyArray<DiffOp>, context: number): Hunk[] => {
  const changed = ops.map((o) => o.tag !== "eq")
  // 1-based old/new line number at each op position.
  const oldNo = new Array<number>(ops.length)
  const newNo = new Array<number>(ops.length)
  let o = 1
  let nw = 1
  for (let k = 0; k < ops.length; k++) {
    oldNo[k] = o
    newNo[k] = nw
    if (ops[k]!.tag !== "add") o++
    if (ops[k]!.tag !== "del") nw++
  }

  const hunks: Hunk[] = []
  let k = 0
  while (k < ops.length) {
    if (!changed[k]) {
      k++
      continue
    }
    const start = k
    let end = k
    let j = k
    while (j < ops.length) {
      if (changed[j]) {
        end = j
        j++
        continue
      }
      let e = j
      while (e < ops.length && !changed[e]) e++
      if (e < ops.length && e - j <= context * 2) {
        j = e // small gap between changes — absorb it
        continue
      }
      break
    }
    const ctxStart = Math.max(0, start - context)
    const ctxEnd = Math.min(ops.length - 1, end + context)
    const lines: string[] = []
    let oldCount = 0
    let newCount = 0
    for (let p = ctxStart; p <= ctxEnd; p++) {
      const op = ops[p]!
      lines.push((op.tag === "eq" ? " " : op.tag === "del" ? "-" : "+") + op.line)
      if (op.tag !== "add") oldCount++
      if (op.tag !== "del") newCount++
    }
    hunks.push({
      oldStart: oldNo[ctxStart]!,
      oldCount,
      newStart: newNo[ctxStart]!,
      newCount,
      lines,
    })
    k = ctxEnd + 1
  }
  return hunks
}

/**
 * Common prefix/suffix trim — one hunk, no context. Kept as the fallback for
 * inputs too large for the O(n·m) LCS table (over-reports the gap between
 * distant edits, but bounded memory).
 */
const trimmedDiff = (a: ReadonlyArray<string>, b: ReadonlyArray<string>, path: string): string => {
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

/**
 * Unified diff over a real line-level LCS: multiple hunks in file order, each
 * with up to 3 context lines and a correct `@@ -old,n +new,m @@` header. The
 * renderer parses those headers for the line-number gutter, and the model
 * sees canonical unified-diff text. Falls back to a bounded prefix/suffix
 * trim for very large inputs.
 */
export const unifiedDiff = (before: string, after: string, path: string): string => {
  if (before === after) return ""
  const a = before.split("\n")
  const b = after.split("\n")
  // O(n·m) table guard — fall back to the bounded trim past ~2000² cells.
  if (a.length * b.length > 4_000_000) return trimmedDiff(a, b, path)
  const hunks = groupHunks(diffLines(a, b), 3)
  if (hunks.length === 0) return ""
  const lines: string[] = [`--- ${path}`, `+++ ${path}`]
  for (const h of hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`)
    lines.push(...h.lines)
  }
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

export const Failure = Schema.Struct({
  error: Schema.String,
  message: Schema.optional(Schema.String),
})
export type Failure = typeof Failure.Type

/**
 * Normalise an arbitrary thrown/failed value into the shared `Failure`
 * struct. An already-tagged failure (a `{ error: "<Tag>", message? }`
 * object, e.g. `OutOfScope` / `EditFailed`) is preserved verbatim so the
 * model sees the intended tag; everything else is wrapped (`_tag` → error,
 * best-effort message).
 */
export const toFailure = (e: unknown): Failure => {
  if (
    typeof e === "object" &&
    e !== null &&
    "error" in e &&
    typeof (e as { error: unknown }).error === "string"
  ) {
    const o = e as { error: string; message?: unknown }
    return {
      error: o.error,
      ...(o.message !== undefined ? { message: String(o.message) } : {}),
    }
  }
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
  success: Schema.Struct({ path: Schema.String, bytes: Schema.Number, lines: Schema.Number }),
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

export const WebSearchTool = Tool.make("web_search", {
  description:
    "Search the web for current information and get a short synthesized answer with source URLs. Use it to find things you don't know or that may have changed — library versions, API docs, recent events — when you don't already have a URL. It returns a summary plus its sources; call web_fetch on a source url to read that page in full.",
  parameters: {
    query: Schema.String.annotations({
      description:
        "What to search for. Prefer specific keywords over a long question; add a year or 'latest' when currency matters.",
    }),
  },
  success: Schema.Struct({
    answer: Schema.String,
    sources: Schema.Array(
      Schema.Struct({ title: Schema.String, url: Schema.String }),
    ),
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
  WebSearchTool,
)

/**
 * Binds the coding handlers to a scope. For the **root** scope
 * `rootDir === displayRoot ===` the workspace and `enforceWrite` is false,
 * so behaviour is identical to a plain workspace-wide agent. For a **child**
 * scope, `rootDir` is the scope dir (writes + bash confined there) while
 * `displayRoot` stays the workspace root (reads/grep/glob/ls range over the
 * whole tree and paths render workspace-relative).
 */
export interface ScopeBinding {
  /** Absolute path; writes + bash are confined here when `enforceWrite`. */
  readonly rootDir: string
  /** Absolute anchor for path resolution + relative display (workspace root). */
  readonly displayRoot: string
  /** Reject `write_file`/`edit_file` outside `rootDir`. False for the root. */
  readonly enforceWrite: boolean
  /** Allow the `bash` tool. */
  readonly allowBash: boolean
}

/**
 * Build the coding-tool handler record for a scope, resolving
 * `FileSystem`/`Shell`/`Http` from context once at build time. Shared by
 * `codingToolkitLayer` (root, back-compat) and `buildScopeRuntime` (which
 * merges in `delegate_to_<child>` handlers). Each returned handler is an
 * `R = never` Effect (it closes over the resolved services).
 */
export const makeCodingHandlers = (
  binding: ScopeBinding,
  skills: ReadonlyArray<Skill> = [],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const shell = yield* Shell
    const http = yield* Http
    const webSearch = yield* WebSearchPort
    const { rootDir, displayRoot, enforceWrite, allowBash } = binding
    const skillByName = new Map(skills.map((s) => [s.name, s] as const))

    const rejectIfOutOfScope = (abs: string) =>
      enforceWrite && !isWithinScope(abs, rootDir)
        ? Effect.fail({
            error: "OutOfScope",
            message: `${displayPath(displayRoot, abs)} is outside this scope (${displayPath(displayRoot, rootDir)}). Defer it to the parent in your summary.`,
          })
        : Effect.void

    return codingToolkit.of({
      read_file: ({ path, offset, limit }) =>
        Effect.gen(function* () {
          const abs = resolvePath(displayRoot, path)
          const result = yield* fs.read(abs, {
            ...(offset !== undefined ? { offset } : {}),
            ...(limit !== undefined ? { limit } : {}),
          })
          return {
            path: displayPath(displayRoot, abs),
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
          const abs = resolvePath(displayRoot, path)
          yield* rejectIfOutOfScope(abs)
          yield* fs.write(abs, content)
          return {
            path: displayPath(displayRoot, abs),
            bytes: new TextEncoder().encode(content).byteLength,
            lines: content === "" ? 0 : content.replace(/\n$/, "").split("\n").length,
          }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      edit_file: ({ path, edits }) =>
        Effect.gen(function* () {
          const abs = resolvePath(displayRoot, path)
          yield* rejectIfOutOfScope(abs)
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
            path: displayPath(displayRoot, abs),
            editsApplied: edits.length,
            diff: unifiedDiff(
              before.content,
              applied.result,
              displayPath(displayRoot, abs),
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
            cwd: rootDir,
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
          const target = dir !== undefined ? resolvePath(displayRoot, dir) : displayRoot
          const ctxFlag = context !== undefined ? ` -C ${context}` : ""
          const extra = flags !== undefined ? ` ${flags}` : ""
          const escaped = pattern.replace(/'/g, "'\\''")
          const cmd = `grep -rnE${ctxFlag}${extra} --exclude-dir=.git --exclude-dir=node_modules '${escaped}' ${JSON.stringify(target)} || true`
          const r = yield* shell.exec({ command: cmd, cwd: displayRoot, timeoutMs: 30_000 })
          return {
            dir: displayPath(displayRoot, target),
            pattern,
            output: truncateOutput(r.stdout, 32_000),
            exitCode: r.exitCode ?? -1,
          }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      glob: ({ pattern, dir }) =>
        Effect.gen(function* () {
          const target = dir !== undefined ? resolvePath(displayRoot, dir) : displayRoot
          const matches = yield* fs.glob(pattern, {
            cwd: target,
            respectGitignore: true,
          })
          return {
            dir: displayPath(displayRoot, target),
            pattern,
            matches: matches.slice(0, 200),
            truncated: matches.length > 200,
            total: matches.length,
          }
        }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))),

      ls: ({ path, recursive }) =>
        Effect.gen(function* () {
          const target = path !== undefined ? resolvePath(displayRoot, path) : displayRoot
          const entries = yield* fs.list(target, {
            ...(recursive !== undefined ? { recursive } : {}),
          })
          return {
            path: displayPath(displayRoot, target),
            entries: entries.slice(0, 500).map((e) => ({
              path: displayPath(displayRoot, e.path),
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

      web_search: ({ query }) =>
        webSearch.search(query).pipe(
          Effect.map((r) => ({ answer: r.answer, sources: r.sources })),
          Effect.catchAll((e) => Effect.fail(toFailure(e))),
        ),

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
    })
  })

/**
 * Handler Layer for the coding toolkit, bound to a workspace `cwd` and the
 * discovered `skills` — the root scope's flavour (writes unrestricted, paths
 * anchored on `cwd`). Requires `FileSystem | Shell | Http`, satisfied at the
 * driver's composition root. `buildScopeRuntime` builds richer per-scope
 * layers on top of `makeCodingHandlers`.
 */
export const codingToolkitLayer = (
  cwd: string,
  skills: ReadonlyArray<Skill> = [],
  options: { readonly allowBash?: boolean } = {},
) =>
  codingToolkit.toLayer(
    makeCodingHandlers(
      {
        rootDir: cwd,
        displayRoot: cwd,
        enforceWrite: false,
        allowBash: options.allowBash ?? true,
      },
      skills,
    ),
  )
