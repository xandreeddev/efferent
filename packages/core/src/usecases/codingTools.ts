import { isAbsolute, relative, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { type AgentTool, AgentToolError } from "../entities/AgentTool.js"
import type { Skill } from "../entities/Skill.js"
import { FileSystem } from "../ports/FileSystem.js"
import { Shell } from "../ports/Shell.js"

const wrap = (toolName: string) =>
  Effect.mapError((cause: unknown) => new AgentToolError({ tool: toolName, cause }))

const resolvePath = (cwd: string, path: string): string =>
  isAbsolute(path) ? path : resolve(cwd, path)

const displayPath = (cwd: string, path: string): string => {
  const rel = relative(cwd, path)
  return rel.startsWith("..") || rel.length === 0 ? path : rel
}

const ReadFileInput = Schema.Struct({
  path: Schema.String.annotations({
    description: "Path to the file (relative to cwd, or absolute).",
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
    description: "Path to the file (relative to cwd, or absolute).",
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
    description: "Path to the file to edit.",
  }),
  edits: Schema.Array(EditSpec).annotations({
    description:
      "One or more substring edits, applied in order. Each oldText must match exactly once.",
  }),
})

const BashInput = Schema.Struct({
  command: Schema.String.annotations({
    description: "Shell command. Runs via 'bash -c' in the workspace cwd.",
  }),
  timeout: Schema.optional(
    Schema.Number.annotations({
      description: "Timeout in milliseconds. Defaults to 60000.",
    }),
  ),
})

const GrepInput = Schema.Struct({
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
})

const GlobInput = Schema.Struct({
  pattern: Schema.String.annotations({
    description: "Glob pattern (e.g. '**/*.ts'). Respects .gitignore.",
  }),
  dir: Schema.optional(
    Schema.String.annotations({
      description: "Directory to glob in. Defaults to cwd.",
    }),
  ),
})

const LsInput = Schema.Struct({
  path: Schema.optional(
    Schema.String.annotations({
      description: "Directory to list. Defaults to cwd.",
    }),
  ),
  recursive: Schema.optional(
    Schema.Boolean.annotations({ description: "Recurse into subdirectories." }),
  ),
})

const ReadSkillInput = Schema.Struct({
  name: Schema.String.annotations({
    description:
      "Skill name (the value listed in the system prompt's Skills section).",
  }),
})

const buildReadSkillTool = (
  skills: ReadonlyArray<Skill>,
): AgentTool<any, any, FileSystem> => {
  const byName = new Map(skills.map((s) => [s.name, s] as const))
  return {
    name: "read_skill",
    description:
      "Read the full body of a named skill (a markdown procedure). Use when a skill's name and one-line description in the prompt suggest it applies to the current task — then follow the steps described in the body.",
    parameters: ReadSkillInput,
    execute: ({ name }: { name: string }) =>
      Effect.gen(function* () {
        const skill = byName.get(name)
        if (skill === undefined) {
          return {
            ok: false as const,
            error: "UnknownSkill",
            message: `No skill named '${name}'. Available: ${
              [...byName.keys()].join(", ") || "(none)"
            }`,
          }
        }
        const fs = yield* FileSystem
        const read = yield* fs.read(skill.sourcePath)
        return {
          name: skill.name,
          sourcePath: skill.sourcePath,
          body: stripFrontmatter(read.content),
        }
      }).pipe(wrap("read_skill")),
  }
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

export const buildCodingTools = (
  cwd: string,
  skills: ReadonlyArray<Skill> = [],
): ReadonlyArray<AgentTool<any, any, FileSystem | Shell>> => [
  ...(skills.length > 0 ? [buildReadSkillTool(skills)] : []),
  {
    name: "read_file",
    description:
      "Read a file's contents with line numbers. Use offset/limit to page through large files.",
    parameters: ReadFileInput,
    execute: ({ path, offset, limit }: { path: string; offset?: number; limit?: number }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem
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
      }).pipe(wrap("read_file")),
  },
  {
    name: "write_file",
    description:
      "Create or fully replace a file. Use 'edit_file' instead for targeted in-place edits to existing files.",
    parameters: WriteFileInput,
    execute: ({ path, content }: { path: string; content: string }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem
        const abs = resolvePath(cwd, path)
        yield* fs.write(abs, content)
        return {
          path: displayPath(cwd, abs),
          bytes: new TextEncoder().encode(content).byteLength,
        }
      }).pipe(wrap("write_file")),
  },
  {
    name: "edit_file",
    description:
      "Apply targeted substring edits to a file. Each edit's oldText must match exactly once in the current file content.",
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
        const abs = resolvePath(cwd, path)
        const before = yield* fs.read(abs)
        const applied = applyEditsToContent(before.content, edits)
        if (applied.error !== undefined) {
          return {
            ok: false as const,
            path: displayPath(cwd, abs),
            error: applied.error,
          }
        }
        yield* fs.write(abs, applied.result)
        return {
          path: displayPath(cwd, abs),
          editsApplied: edits.length,
          diff: unifiedDiff(before.content, applied.result, displayPath(cwd, abs)),
        }
      }).pipe(wrap("edit_file")),
  },
  {
    name: "bash",
    description:
      "Execute a shell command in the workspace. Use for git, build, test, install, and other operations not covered by the other tools.",
    parameters: BashInput,
    execute: ({ command, timeout }: { command: string; timeout?: number }) =>
      Effect.gen(function* () {
        const shell = yield* Shell
        const r = yield* shell.exec({
          command,
          cwd,
          timeoutMs: timeout ?? 60_000,
        })
        return {
          exitCode: r.exitCode,
          stdout: truncateOutput(r.stdout, 32_000),
          stderr: truncateOutput(r.stderr, 8_000),
          durationMs: r.durationMs,
          timedOut: r.timedOut,
        }
      }).pipe(wrap("bash")),
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
          exitCode: r.exitCode,
        }
      }).pipe(wrap("grep")),
  },
  {
    name: "glob",
    description:
      "Find files matching a glob pattern (e.g. '**/*.ts'). Respects .gitignore. Returns relative paths.",
    parameters: GlobInput,
    execute: ({ pattern, dir }: { pattern: string; dir?: string }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem
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
      }).pipe(wrap("glob")),
  },
  {
    name: "ls",
    description: "List a directory's entries. Use recursive: true to descend.",
    parameters: LsInput,
    execute: ({ path, recursive }: { path?: string; recursive?: boolean }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem
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
      }).pipe(wrap("ls")),
  },
]
