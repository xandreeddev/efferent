/**
 * Pure formatters that turn raw tool calls/results into short, human
 * labels for the execution tree and the chat scrollback. No IO.
 */

const base = (p: string): string => {
  const cleaned = p.endsWith("/") ? p.slice(0, -1) : p
  const idx = cleaned.lastIndexOf("/")
  return idx === -1 ? cleaned : cleaned.slice(idx + 1)
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined

const num = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`

/** A semantic one-line label for a tool *call*, e.g. `read keys.ts L1-40`. */
export const describeToolCall = (toolName: string, args: unknown): string => {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<
    string,
    unknown
  >
  if (toolName.startsWith("delegate_to_")) {
    return `delegate → ${toolName.slice("delegate_to_".length)}`
  }
  switch (toolName) {
    case "read_file": {
      const path = str(a.path)
      const offset = num(a.offset)
      const limit = num(a.limit)
      const span =
        offset !== undefined
          ? ` L${offset}-${offset + (limit ?? 0)}`
          : ""
      return `read ${path ? base(path) : "?"}${span}`
    }
    case "write_file":
      return `write ${str(a.path) ? base(str(a.path)!) : "?"}`
    case "edit_file":
      return `edit ${str(a.path) ? base(str(a.path)!) : "?"}`
    case "bash":
      return `$ ${truncate(str(a.command) ?? "", 60)}`
    case "grep":
      return `grep '${truncate(str(a.pattern) ?? "", 40)}'`
    case "glob":
      return `glob ${truncate(str(a.pattern) ?? "", 40)}`
    case "ls":
      return `ls ${str(a.path) ? base(str(a.path)!) : "."}`
    case "read_skill":
      return `skill ${str(a.name) ?? "?"}`
    case "web_fetch":
      return `fetch ${truncate(str(a.url) ?? "", 60)}`
    default:
      return toolName
  }
}

const countDiffLines = (diff: string): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  return { added, removed }
}

/**
 * A short detail string for a finished tool, e.g. `+6/-2`, `exit 0`,
 * `12 matches`, or an error message. `undefined` = nothing worth showing.
 */
export const describeToolResult = (
  toolName: string,
  ok: boolean,
  result: unknown,
): string | undefined => {
  const r = (typeof result === "object" && result !== null ? result : {}) as Record<
    string,
    unknown
  >

  if (!ok) {
    const msg = str(r.message) ?? str(r.reason) ?? str(r.error)
    return msg !== undefined ? truncate(msg, 60) : "failed"
  }

  if (toolName.startsWith("delegate_to_")) {
    const files = Array.isArray(r.filesChanged) ? r.filesChanged.length : 0
    return files > 0 ? `${files} file${files === 1 ? "" : "s"}` : undefined
  }
  switch (toolName) {
    case "edit_file": {
      const diff = str(r.diff)
      if (diff !== undefined) {
        const { added, removed } = countDiffLines(diff)
        return `+${added}/-${removed}`
      }
      const applied = num(r.editsApplied)
      return applied !== undefined ? `${applied} edits` : undefined
    }
    case "read_file": {
      const total = num(r.totalLines)
      return total !== undefined ? `${total} lines` : undefined
    }
    case "write_file": {
      const bytes = num(r.bytes)
      return bytes !== undefined ? `${bytes}b` : undefined
    }
    case "bash": {
      const code = num(r.exitCode)
      const timedOut = r.timedOut === true
      const codePart = code !== undefined ? `exit ${code}` : undefined
      if (timedOut) return codePart ? `${codePart} · timed out` : "timed out"
      return codePart
    }
    case "grep": {
      const output = str(r.output) ?? ""
      const n = output.trim() === "" ? 0 : output.trim().split("\n").length
      return `${n} match${n === 1 ? "" : "es"}`
    }
    case "glob": {
      const total = num(r.total)
      return total !== undefined ? `${total} files` : undefined
    }
    case "ls": {
      const total = num(r.total)
      return total !== undefined ? `${total} entries` : undefined
    }
    default:
      return undefined
  }
}

/**
 * Rich artifacts to render below a tool pill: a unified `diff` (edit_file)
 * or full textual `output` (bash/grep/read_file). Empty when nothing to show.
 */
export const toolArtifacts = (
  toolName: string,
  ok: boolean,
  result: unknown,
): { diff?: string; output?: string } => {
  if (!ok) return {}
  const r = (typeof result === "object" && result !== null ? result : {}) as Record<
    string,
    unknown
  >
  switch (toolName) {
    case "edit_file": {
      const diff = str(r.diff)
      return diff !== undefined && diff.length > 0 ? { diff } : {}
    }
    case "bash": {
      const stdout = str(r.stdout) ?? ""
      const stderr = str(r.stderr) ?? ""
      const out =
        stderr.trim().length > 0 ? `${stdout}\n[stderr]\n${stderr}` : stdout
      return out.trim().length > 0 ? { output: out } : {}
    }
    case "grep": {
      const o = str(r.output)
      return o !== undefined && o.trim().length > 0 ? { output: o } : {}
    }
    case "read_file": {
      const c = str(r.content)
      return c !== undefined && c.length > 0 ? { output: c } : {}
    }
    default:
      return {}
  }
}
