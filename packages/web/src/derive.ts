/**
 * Event → workspace-card derivation: given a finished tool call (name, args,
 * result — all `unknown`, parsed structurally the way the TUI's toolDescribe
 * does), decide what lands in the workspace pane. Pure and defensive: a
 * missing/odd field means "no card", never a throw.
 */
import type { DiffCardView, FileRefView, PlanView, SourceCardView, WorkspaceItemView } from "./views.js"

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

/** `read_file` returns line-numbered text (`  12\tcode`); parse it back. */
const parseNumberedContent = (
  numbered: string,
): { content: string; startLine: number; truncated: boolean } | undefined => {
  const lines = numbered.split("\n")
  const out: string[] = []
  let startLine: number | undefined
  let truncated = false
  for (const line of lines) {
    const m = /^\s*(\d+)\t(.*)$/.exec(line)
    if (m !== null) {
      if (startLine === undefined) startLine = Number(m[1])
      out.push(m[2] ?? "")
      continue
    }
    if (/^\.\.\. \(truncated/.test(line)) {
      truncated = true
      continue
    }
    // Continuation of a hard-wrapped line or unexpected shape — keep verbatim.
    if (startLine !== undefined) out.push(line)
  }
  if (startLine === undefined) return undefined
  return { content: out.join("\n"), startLine, truncated }
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

const PLAN_STATUS: Record<string, "todo" | "active" | "done"> = {
  pending: "todo",
  todo: "todo",
  active: "active",
  in_progress: "active",
  done: "done",
  completed: "done",
}

const derivePlan = (args: unknown): PlanView | undefined => {
  const steps = rec(args)["steps"]
  if (!Array.isArray(steps)) return undefined
  const out = steps.flatMap((s) => {
    const r = rec(s)
    const text = str(r["step"]) ?? str(r["text"])
    if (text === undefined) return []
    const status = PLAN_STATUS[str(r["status"])?.toLowerCase() ?? ""] ?? "todo"
    return [{ text, status }]
  })
  return out.length > 0 ? { steps: out } : undefined
}

const deriveFile = (args: unknown, result: unknown): FileRefView | undefined => {
  const r = rec(result)
  const path = str(r["path"]) ?? str(rec(args)["path"])
  const numbered = str(r["content"])
  if (path === undefined || numbered === undefined) return undefined
  const parsed = parseNumberedContent(numbered)
  if (parsed === undefined) return undefined
  const truncated = parsed.truncated || r["truncated"] === true
  return {
    path,
    content: parsed.content,
    startLine: parsed.startLine,
    ...(truncated && { truncated: true }),
  }
}

const deriveDiff = (id: string, args: unknown, result: unknown): DiffCardView | undefined => {
  const r = rec(result)
  const diff = str(r["diff"])
  const path = str(r["path"]) ?? str(rec(args)["path"])
  if (diff === undefined || diff === "" || path === undefined) return undefined
  const { added, removed } = countDiffLines(diff)
  return { id, path, diff, added, removed }
}

const deriveSources = (result: unknown): SourceCardView["sources"] => {
  const sources = rec(result)["sources"]
  if (!Array.isArray(sources)) return []
  return sources.flatMap((s) => {
    const r = rec(s)
    const url = str(r["url"])
    if (url === undefined) return []
    const title = str(r["title"])
    return [title !== undefined ? { url, title } : { url }]
  })
}

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max)}…`)

/**
 * The main entry: what workspace card (if any) does this finished tool call
 * produce? `undefined` = nothing (the rail pill is enough).
 */
export const deriveWorkspaceItem = (
  toolName: string,
  callId: string,
  args: unknown,
  ok: boolean,
  result: unknown,
): WorkspaceItemView | undefined => {
  if (!ok) return undefined
  switch (toolName) {
    case "update_plan": {
      const plan = derivePlan(args)
      return plan === undefined ? undefined : { kind: "plan", plan }
    }
    case "read_file": {
      const file = deriveFile(args, result)
      return file === undefined ? undefined : { kind: "file", file }
    }
    case "edit_file":
    case "write_file": {
      const diff = deriveDiff(callId, args, result)
      return diff === undefined ? undefined : { kind: "diff", diff }
    }
    case "web_fetch": {
      const r = rec(result)
      const url = str(rec(args)["url"]) ?? str(r["url"])
      if (url === undefined) return undefined
      const status = num(r["status"])
      const content = str(r["content"])
      return {
        kind: "source",
        source: {
          id: callId,
          kind: "fetch",
          url,
          ...(status !== undefined && { status }),
          ...(content !== undefined && { answer: clip(content, 600) }),
          sources: [],
        },
      }
    }
    case "search_web": {
      const r = rec(result)
      const answer = str(r["answer"])
      const query = str(rec(args)["query"])
      const sources = deriveSources(result)
      if (answer === undefined && sources.length === 0) return undefined
      return {
        kind: "source",
        source: {
          id: callId,
          kind: "search",
          ...(query !== undefined && { query }),
          ...(answer !== undefined && { answer: clip(answer, 600) }),
          sources,
        },
      }
    }
    default:
      return undefined
  }
}
