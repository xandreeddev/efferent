import type { FleetMessage, SessionSummary, WorkspaceMetrics } from "@xandreed/sdk-core"
import type { NavRow } from "../../presentation/paneNav.js"
import { formatTokens } from "../../presentation/statusBar.js"

/**
 * Pure L1 for the k9s-style control dashboard — folds the daemon's
 * `WorkspaceMetrics` + `SessionSummary[]` + `FleetMessage[]` into render-ready
 * rows/segments. No Solid/OpenTUI (same discipline as `presentation/`), so the
 * whole model is unit-testable without a renderer.
 *
 * Control-plane vocabulary: a **fleet** (root session) is a deployment; its
 * **agents** (sub-agent nodes) are pods nested under it.
 */

export interface DashboardRow extends NavRow {
  readonly depth: number
  /** git-graph connector prefix for this row (`""` for a fleet, `├─ `/`└─ ` for agents). */
  readonly rail: string
  readonly display:
    | { readonly kind: "fleet"; readonly summary: SessionSummary }
    | { readonly kind: "agent"; readonly summary: SessionSummary }
}

/**
 * Flatten fleets → agents into navigable rows (a fleet is a depth-0 head; its
 * agents nest beneath with rail connectors). Folding a fleet (`fleet:<id>` in
 * `collapsed`) hides its agents — the k9s "collapse a deployment" gesture.
 */
export const buildFleetRows = (
  sessions: ReadonlyArray<SessionSummary>,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<DashboardRow> => {
  const roots = sessions.filter((s) => s.kind === "root")
  // parentId → children (agents). A top-level agent's parentId is its fleet root.
  const childrenOf = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    if (s.kind !== "agent" || s.parentId === null) continue
    const arr = childrenOf.get(s.parentId) ?? []
    arr.push(s)
    childrenOf.set(s.parentId, arr)
  }
  const rows: DashboardRow[] = []
  const walkAgents = (parentId: string, depth: number, prefix: string): void => {
    const kids = childrenOf.get(parentId) ?? []
    kids.forEach((k, i) => {
      const last = i === kids.length - 1
      rows.push({
        key: `agent:${k.id}`,
        head: false,
        depth,
        rail: `${prefix}${last ? "└─ " : "├─ "}`,
        display: { kind: "agent", summary: k },
      })
      walkAgents(k.id as string, depth + 1, `${prefix}${last ? "   " : "│  "}`)
    })
  }
  for (const root of roots) {
    const foldId = `fleet:${root.id}`
    rows.push({
      key: foldId,
      foldId,
      head: true,
      depth: 0,
      rail: "",
      display: { kind: "fleet", summary: root },
    })
    if (!collapsed.has(foldId)) walkAgents(root.id as string, 1, "")
  }
  return rows
}

const fmtUptime = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m - h * 60}m`
}

/** The header metrics strip as labeled segments (the view joins + colours). */
export const dashboardMetricsSegments = (m: WorkspaceMetrics): ReadonlyArray<string> => {
  const tok = Object.values(m.tokensByRole).reduce(
    (a, r) => ({ input: a.input + r.input, output: a.output + r.output }),
    { input: 0, output: 0 },
  )
  return [
    `${m.fleets} fleet${m.fleets === 1 ? "" : "s"}`,
    `${m.agentsRunning}▶ ${m.agentsDone}✓ agents`,
    `↑${formatTokens(tok.input)} ↓${formatTokens(tok.output)}`,
    m.costUsdTotal > 0 ? `$${m.costUsdTotal.toFixed(2)}` : "$—",
    `${m.turns} turns`,
    `${m.toolCallsOk}✓${m.toolCallsFail > 0 ? ` ${m.toolCallsFail}✗` : ""} tools`,
    `${m.messagesPerMin}/min msgs`,
    `up ${fmtUptime(m.uptimeMs)}`,
  ]
}

/** Status glyph for a session row (mirrors the context-tree glyphs). */
export const statusGlyph = (status: SessionSummary["status"]): string =>
  status === "running" ? "●" : status === "ok" ? "✓" : status === "error" ? "✗" : "○"

/** One message line for the "messages flying" pane. */
export interface MessageLine {
  readonly from: string
  readonly content: string
  readonly at: number
}
export const messageLine = (m: FleetMessage): MessageLine => ({
  from: m.from,
  content: m.content,
  at: m.at,
})
