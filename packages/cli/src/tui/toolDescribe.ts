/**
 * Pure formatters that turn raw tool calls/results into short, human
 * labels for the execution tree and the chat scrollback. No IO.
 */

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined

const num = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`

/** Truncate a path keeping its tail (the filename stays visible): `…/math.ts`. */
const truncPath = (p: string, n = 42): string =>
  p.length <= n ? p : `…${p.slice(p.length - (n - 1))}`

/**
 * A Claude-style `ToolName(arg)` label for a tool *call*, e.g. `Read(keys.ts)`,
 * `Edit(src/math.ts)`, `Bash(npm run build)`. Used by both the conversation rail
 * and the Activity tree; line ranges / counts live in the result summary, not here.
 */
export const describeToolCall = (toolName: string, args: unknown): string => {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<
    string,
    unknown
  >
  if (toolName.startsWith("delegate_to_")) {
    return `Task(${toolName.slice("delegate_to_".length)})`
  }
  const path = (fallback: string): string =>
    str(a.path) ? truncPath(str(a.path)!) : fallback
  switch (toolName) {
    case "read_file":
      return `Read(${path("?")})`
    case "write_file":
      return `Write(${path("?")})`
    case "edit_file":
      return `Edit(${path("?")})`
    case "Bash":
      return `Bash(${truncate(str(a.command) ?? "", 50)})`
    case "grep":
      return `Grep(${truncate(str(a.pattern) ?? "", 40)})`
    case "glob":
      return `Glob(${truncate(str(a.pattern) ?? "", 40)})`
    case "ls":
      return `Ls(${path(".")})`
    case "read_skill":
      return `Skill(${str(a.name) ?? "?"})`
    case "web_fetch":
      return `Fetch(${truncate(str(a.url) ?? "", 50)})`
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
      return total !== undefined ? `${total} lines` : "read"
    }
    case "write_file": {
      const lines = num(r.lines)
      if (lines !== undefined) return `wrote ${lines} line${lines === 1 ? "" : "s"}`
      const bytes = num(r.bytes)
      return bytes !== undefined ? `wrote ${bytes} bytes` : "written"
    }
    case "Bash": {
      const code = num(r.exitCode)
      const timedOut = r.timedOut === true
      const codePart = code !== undefined ? `exit ${code}` : "done"
      return timedOut ? `${codePart} · timed out` : codePart
    }
    case "grep": {
      const output = str(r.output) ?? ""
      const n = output.trim() === "" ? 0 : output.trim().split("\n").length
      return `${n} match${n === 1 ? "" : "es"}`
    }
    case "glob": {
      const total = num(r.total)
      return total !== undefined ? `${total} files` : "globbed"
    }
    case "ls": {
      const total = num(r.total)
      return total !== undefined ? `${total} entries` : "listed"
    }
    case "read_skill":
      return "loaded"
    case "web_fetch": {
      const status = num(r.status)
      const bytes = str(r.content)?.length
      const parts = [
        status !== undefined ? `${status}` : undefined,
        bytes !== undefined ? `${bytes} chars` : undefined,
      ].filter((p): p is string => p !== undefined)
      return parts.length > 0 ? parts.join(" · ") : "fetched"
    }
    default:
      return "done"
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
    case "Bash": {
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
