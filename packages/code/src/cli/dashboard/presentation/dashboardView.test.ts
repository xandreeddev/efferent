import { describe, expect, test } from "bun:test"
import type { SessionSummary, WorkspaceMetrics } from "@xandreed/sdk-core"
import { buildFleetRows, dashboardMetricsSegments, statusGlyph } from "./dashboardView.js"

const root = (id: string, model?: string): SessionSummary => ({
  id: id as never,
  kind: "root",
  folder: "/ws",
  status: "idle",
  parentId: null,
  ...(model !== undefined ? { model } : {}),
})
const agent = (id: string, parent: string, status: SessionSummary["status"] = "running"): SessionSummary => ({
  id: id as never,
  kind: "agent",
  folder: "/ws/pkg",
  status,
  parentId: parent as never,
})

describe("buildFleetRows", () => {
  test("fleets are depth-0 heads; agents nest under their fleet with rails", () => {
    const sessions = [
      root("f1"),
      agent("a1", "f1"),
      agent("a2", "f1"),
      root("f2"),
    ]
    const rows = buildFleetRows(sessions, new Set())
    expect(rows.map((r) => r.display.kind)).toEqual(["fleet", "agent", "agent", "fleet"])
    expect(rows[0]!.depth).toBe(0)
    expect(rows[0]!.foldId).toBe("fleet:f1")
    expect(rows[1]!.depth).toBe(1)
    expect(rows[1]!.rail).toBe("├─ ") // not last
    expect(rows[2]!.rail).toBe("└─ ") // last child
    expect(String(rows[3]!.display.summary.id)).toBe("f2")
  })

  test("nested agents (a pod spawns a pod) deepen with continuation rails", () => {
    const sessions = [root("f1"), agent("a1", "f1"), agent("a2", "a1")]
    const rows = buildFleetRows(sessions, new Set())
    const deep = rows.find((r) => r.display.summary.id === "a2")!
    expect(deep.depth).toBe(2)
    expect(deep.rail).toContain("└─ ")
  })

  test("collapsing a fleet hides its agents", () => {
    const sessions = [root("f1"), agent("a1", "f1"), root("f2")]
    const rows = buildFleetRows(sessions, new Set(["fleet:f1"]))
    // f1 (collapsed, no agents) + f2 only.
    expect(rows.map((r) => String(r.display.summary.id))).toEqual(["f1", "f2"])
  })
})

describe("dashboardMetricsSegments", () => {
  test("renders the headline counters", () => {
    const m: WorkspaceMetrics = {
      tokensByRole: { main: { input: 64000, output: 12000, cache: 0, costUsd: 0.02 } },
      costUsdTotal: 0.02,
      agentsRunning: 3,
      agentsDone: 5,
      fleets: 2,
      turns: 18,
      toolCallsOk: 30,
      toolCallsFail: 1,
      errors: 0,
      approvalsPrompted: 0,
      messagesPerMin: 4,
      uptimeMs: 12 * 60 * 1000,
    }
    const segs = dashboardMetricsSegments(m)
    expect(segs).toContain("2 fleets")
    expect(segs).toContain("3▶ 5✓ agents")
    expect(segs.some((s) => s.includes("↑64k"))).toBe(true)
    expect(segs).toContain("$0.02")
    expect(segs).toContain("18 turns")
    expect(segs.some((s) => s.includes("30✓") && s.includes("1✗"))).toBe(true)
    expect(segs).toContain("up 12m")
  })

  test("under-reported cost shows a dash, not 0", () => {
    const m = {
      tokensByRole: {},
      costUsdTotal: 0,
      agentsRunning: 0,
      agentsDone: 0,
      fleets: 1,
      turns: 0,
      toolCallsOk: 0,
      toolCallsFail: 0,
      errors: 0,
      approvalsPrompted: 0,
      messagesPerMin: 0,
      uptimeMs: 0,
    } satisfies WorkspaceMetrics
    expect(dashboardMetricsSegments(m)).toContain("$—")
  })
})

describe("statusGlyph", () => {
  test("maps statuses to glyphs", () => {
    expect(statusGlyph("running")).toBe("●")
    expect(statusGlyph("ok")).toBe("✓")
    expect(statusGlyph("error")).toBe("✗")
    expect(statusGlyph("idle")).toBe("○")
  })
})
