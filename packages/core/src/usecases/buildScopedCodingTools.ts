import { isAbsolute, relative, resolve, sep } from "node:path"
import { Effect, Schema } from "effect"
import { type AgentTool, AgentToolError } from "../entities/AgentTool.js"
import { FileSystem } from "../ports/FileSystem.js"
import { Shell } from "../ports/Shell.js"

/**
 * Scoped variant of `buildCodingTools`:
 *   - Display anchor (`displayRoot`) is the workspace root, so paths in
 *     tool results render relative to the workspace (clearer for the
 *     sub-agent when reading cross-scope files).
 *   - `write_file` / `edit_file` reject any path outside `rootDir` with
 *     `AgentToolError({ cause: { _tag: "OutOfScope", path, rootDir } })`.
 *     The model sees a structured failure and adjusts; the whole turn
 *     doesn't abort.
 *   - **No `bash` tool.** Tests and migrations stay on the parent.
 *
 * Reads (`read_file`, `grep`, `glob`, `ls`) are unrestricted — the
 * sub-agent can learn types and conventions from anywhere in the
 * workspace.
 */

const wrap = (toolName: string) =>
  Effect.mapError((cause: unknown) => new AgentToolError({ tool: toolName, cause }))

const resolvePath = (anchor: string, path: string): string =>
  isAbsolute(path) ? path : resolve(anchor, path)

const displayPath = (anchor: string, path: string): string => {
  const rel = relative(anchor, path)
  return rel.startsWith("..") || rel.length === 0 ? path : rel
}

/**
 * True when `path` lives inside `rootDir` (or *is* `rootDir`). Uses
 * `path.sep` to avoid false positives on prefixes like
 * `/foo/bar` vs `/foo/bar-other`.
 */
const isWithinScope = (path: string, rootDir: string): boolean => {
  const normalisedRoot = rootDir.endsWith(sep) ? rootDir : rootDir + sep
  return path === rootDir || path.startsWith(normalisedRoot)
}

const ReadFileInput = Schema.Struct({
  path: Schema.String.annotations({
    description: "Path to the file (relative to the workspace, or absolute).",
  }),
  offset: Schema.optional(
    Schema.Number.annotations({ description: "1-indexed start line." }),
  ),
  limit: Schema.optional(
    Schema.Number.annotations({ description: "Max lines to return." }),
  ),
})

const WriteFileInput = Schema.Struct({
  path: Schema.String.annotations({
    description:
      "Path to the file. Writes outside the sub-agent's scope are rejected with a tool error.",
  }),
  content: Schema.String.annotations({
    description: "Full content to write. Overwrites any existing file.",
  }),
})

const EditSpec = Schema.Struct({
  oldText: Schema.String.annotations({
    description:
      "Exact substring to find (whitespace and indentation included). Must be unique in the file.",
  }),
  newText: Schema.String.annotations({
    description: "Replacement text.",
  }),
})

const EditFileInput = Schema.Struct({
  path: Schema.String.annotations({
    description:
      "Path to the file to edit. Edits outside the sub-agent's scope are rejected.",
  }),
  edits: Schema.Array(EditSpec).annotations({
    description:
      "One or more substring edits, applied in order. Each oldText must match exactly once.",
  }),
})

const GrepInput = Schema.Struct({
  pattern: Schema.String.annotations({
    description: "Regex to search for. Passed to GNU grep as ERE (-E).",
  }),
  dir: Schema.optional(
    Schema.String.annotations({
      description: "Directory to search in. Defaults to the workspace root.",
    }),
  ),
  flags: Schema.optional(
    Schema.String.annotations({
      description: "Extra grep flags (e.g. '-i'). -rnE are always set.",
    }),
  ),
  context: Schema.optional(
    Schema.Number.annotations({
      description: "Lines of surrounding context to include per match.",
    }),
  ),
})

const GlobInput = Schema.Struct({
  pattern: Schema.String.annotations({
    description: "Glob pattern (e.g. '**/*.ts'). Respects .gitignore.",
  }),
  dir: Schema.optional(
    Schema.String.annotations({
      description: "Directory to glob in. Defaults to the workspace root.",
    }),
  ),
})

const LsInput = Schema.Struct({
  path: Schema.optional(
    Schema.String.annotations({
      description: "Directory to list. Defaults to the workspace root.",
    }),
  ),
  recursive: Schema.optional(
    Schema.Boolean.annotations({ description: "Recurse into subdirectories." }),
  ),
})

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

const unifiedDiff = (before: string, after: string, path: string): string => {
  const a = before.split("\n")
  const b = after.split("\n")
  const lines: string[] = [`--- ${path}`, `+++ ${path}`]
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++
      j++
      continue
    }
    const aStart = i
    const bStart = j
    while (i < a.length && (j >= b.length || a[i] !== b[j])) i++
    while (j < b.length && (i >= a.length || a[i] !== b[j])) j++
    lines.push(
      `@@ -${aStart + 1},${i - aStart} +${bStart + 1},${j - bStart} @@`,
    )
    for (let k = aStart; k < i; k++) lines.push(`-${a[k]}`)
    for (let k = bStart; k < j; k++) lines.push(`+${b[k]}`)
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

export interface ScopedCodingToolsArgs {
  /** Absolute path. Writes outside this prefix are rejected. */
  readonly rootDir: string
  /** Absolute path used as the anchor for relative-path display. */
  readonly displayRoot: string
}

export const buildScopedCodingTools = (
  scope: ScopedCodingToolsArgs,
): ReadonlyArray<AgentTool<any, any, FileSystem | Shell>> => {
  const { rootDir, displayRoot } = scope
  const rejectIfOutOfScope = (toolName: string, abs: string) =>
    isWithinScope(abs, rootDir)
      ? Effect.void
      : Effect.fail(
          new AgentToolError({
            tool: toolName,
            cause: {
              _tag: "OutOfScope",
              path: displayPath(displayRoot, abs),
              rootDir: displayPath(displayRoot, rootDir),
            },
          }),
        )

  return [
    {
      name: "read_file",
      description:
        "Read a file's contents with line numbers. Reads anywhere in the workspace are allowed.",
      parameters: ReadFileInput,
      execute: ({
        path,
        offset,
        limit,
      }: {
        path: string
        offset?: number
        limit?: number
      }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem
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
        }).pipe(wrap("read_file")),
    },
    {
      name: "write_file",
      description:
        "Create or fully replace a file. Writes outside this sub-agent's scope are rejected with a tool error.",
      parameters: WriteFileInput,
      execute: ({ path, content }: { path: string; content: string }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem
          const abs = resolvePath(displayRoot, path)
          yield* rejectIfOutOfScope("write_file", abs)
          yield* fs.write(abs, content)
          return {
            path: displayPath(displayRoot, abs),
            bytes: new TextEncoder().encode(content).byteLength,
          }
        }).pipe(wrap("write_file")),
    },
    {
      name: "edit_file",
      description:
        "Apply targeted substring edits to a file. Edits outside this sub-agent's scope are rejected.",
      parameters: EditFileInput,
      execute: ({
        path,
        edits,
      }: {
        path: string
        edits: ReadonlyArray<{ oldText: string; newText: string }>
      }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem
          const abs = resolvePath(displayRoot, path)
          yield* rejectIfOutOfScope("edit_file", abs)
          const before = yield* fs.read(abs)
          const applied = applyEditsToContent(before.content, edits)
          if (applied.error !== undefined) {
            return {
              ok: false as const,
              path: displayPath(displayRoot, abs),
              error: applied.error,
            }
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
        }).pipe(wrap("edit_file")),
    },
    {
      name: "grep",
      description:
        "Search for a regex pattern across files. Returns matching lines with file:line:text. Respects .gitignore.",
      parameters: GrepInput,
      execute: ({
        pattern,
        dir,
        flags,
        context,
      }: {
        pattern: string
        dir?: string
        flags?: string
        context?: number
      }) =>
        Effect.gen(function* () {
          const shell = yield* Shell
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
            exitCode: r.exitCode,
          }
        }).pipe(wrap("grep")),
    },
    {
      name: "glob",
      description:
        "Find files matching a glob pattern (e.g. '**/*.ts'). Respects .gitignore.",
      parameters: GlobInput,
      execute: ({ pattern, dir }: { pattern: string; dir?: string }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem
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
        }).pipe(wrap("glob")),
    },
    {
      name: "ls",
      description: "List a directory's entries. Use recursive: true to descend.",
      parameters: LsInput,
      execute: ({ path, recursive }: { path?: string; recursive?: boolean }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem
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
        }).pipe(wrap("ls")),
    },
  ]
}
