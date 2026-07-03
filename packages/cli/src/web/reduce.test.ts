import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@xandreed/sdk-core"
import { AGENTS_BLOCK_KEY, emptyModel, type WebModel } from "./model.js"
import { makeWebReducer } from "./reduce.js"

const ROOT = "root-conv"

const run = (
  events: ReadonlyArray<AgentEvent>,
  start?: WebModel,
): { model: WebModel; allPatches: Array<{ kind: string }> } => {
  const reduce = makeWebReducer(ROOT)
  let model = start ?? emptyModel({ phase: "idle", openToolCount: 0 })
  const allPatches: Array<{ kind: string }> = []
  for (const e of events) {
    const r = reduce(model, e)
    model = r.model
    allPatches.push(...r.patches)
  }
  return { model, allPatches }
}

describe("web reducer", () => {
  test("assistant messages key by position — a replay upserts, never duplicates", () => {
    const msg: AgentEvent = { type: "assistant_message", turnIndex: 0, text: "hello", position: 7 }
    const { model } = run([msg, msg])
    const prose = model.blocks.filter((b) => b.block.kind === "assistant")
    expect(prose).toHaveLength(1)
    expect(prose[0]?.key).toBe("m:p7:a0")
  })

  test("same-named parallel tool calls pair FIFO by call id", () => {
    const { model } = run([
      { type: "tool_call_start", turnIndex: 0, id: "c1", toolName: "read_file", args: { path: "a" } },
      { type: "tool_call_start", turnIndex: 0, id: "c2", toolName: "read_file", args: { path: "b" } },
      { type: "tool_call_end", turnIndex: 0, id: "c1", toolName: "read_file", ok: true, result: { path: "a", content: "    1\tx", totalLines: 1, truncated: false } },
    ])
    const pills = model.blocks.filter((b) => b.block.kind === "tool")
    expect(pills).toHaveLength(2)
    const first = pills.find((p) => p.key === "c1")?.block
    const second = pills.find((p) => p.key === "c2")?.block
    expect(first?.kind === "tool" && first.state).toBe("ok")
    expect(second?.kind === "tool" && second.state).toBe("running")
  })

  test("a finished read_file derives a workspace file card; a re-read refreshes it", () => {
    const end = (id: string, content: string): AgentEvent => ({
      type: "tool_call_end",
      turnIndex: 0,
      id,
      toolName: "read_file",
      ok: true,
      result: { path: "src/a.ts", content, totalLines: 9, truncated: false },
    })
    const { model, allPatches } = run([
      { type: "tool_call_start", turnIndex: 0, id: "c1", toolName: "read_file", args: { path: "src/a.ts" } },
      end("c1", "    1\tv1"),
      { type: "tool_call_start", turnIndex: 0, id: "c2", toolName: "read_file", args: { path: "src/a.ts" } },
      end("c2", "    1\tv2"),
    ])
    expect(model.workspace).toHaveLength(1)
    const card = model.workspace[0]
    expect(card?.kind === "file" && card.file.content).toBe("v2")
    const wsPatches = allPatches.filter((p) => p.kind === "workspace")
    expect(wsPatches).toHaveLength(2)
  })

  test("update_plan args become the plan", () => {
    const { model, allPatches } = run([
      {
        type: "tool_call_start",
        turnIndex: 0,
        id: "c1",
        toolName: "update_plan",
        args: { steps: [{ step: "explore", status: "done" }, { step: "build", status: "active" }] },
      },
    ])
    expect(model.plan).toEqual([
      { step: "explore", status: "done" },
      { step: "build", status: "active" },
    ])
    expect(allPatches.some((p) => p.kind === "plan")).toBe(true)
  })

  test("sub-agent events never touch the rail — they aggregate into chips", () => {
    const { model } = run([
      { type: "subagent_start", name: "helper", task: "do x", nodeId: "n1" },
      { type: "tool_call_start", turnIndex: 0, id: "c1", toolName: "grep", args: { pattern: "x" }, nodeId: "n1" },
      { type: "assistant_message", turnIndex: 0, text: "inner prose", nodeId: "n1", usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadTokens: 0 } },
    ])
    // No prose/pill blocks from the sub-agent on the rail:
    expect(model.blocks.filter((b) => b.block.kind === "assistant")).toHaveLength(0)
    expect(model.blocks.filter((b) => b.block.kind === "tool")).toHaveLength(0)
    // One agents container, one chip, live counters:
    const agents = model.blocks.find((b) => b.key === AGENTS_BLOCK_KEY)
    expect(agents).toBeDefined()
    expect(model.agents).toHaveLength(1)
    expect(model.agents[0]?.toolUses).toBe(1)
    expect(model.agents[0]?.tokens).toBe(150)
    expect(model.agents[0]?.currentTool).toMatch(/grep/i)
  })

  test("subagent_end settles the chip and drops a completion line", () => {
    const { model } = run([
      { type: "subagent_start", name: "helper", task: "do x", nodeId: "n1" },
      { type: "subagent_end", name: "helper", nodeId: "n1", ok: true, outcome: "ok", summary: "did x", filesChanged: ["a.ts"] },
    ])
    expect(model.agents[0]?.status).toBe("ok")
    expect(model.agents[0]?.summary).toBe("did x")
    expect(model.blocks.some((b) => b.block.kind === "info" && b.block.text.includes("helper"))).toBe(true)
  })

  test("user_message drains the matching queued echo", () => {
    const start: WebModel = { ...emptyModel({ phase: "thinking", openToolCount: 0 }), queue: ["next thing"] }
    const { model, allPatches } = run(
      [{ type: "user_message", turnIndex: 1, text: "next thing", position: 9 }],
      start,
    )
    expect(model.queue).toHaveLength(0)
    expect(allPatches.some((p) => p.kind === "queue")).toBe(true)
    expect(model.blocks[0]?.key).toBe("m:p9:u0")
  })

  test("ui_render upserts a canvas card (same id updates in place)", () => {
    const { model, allPatches } = run([
      { type: "ui_render", id: "quiz-1", title: "Quiz", html: "<p>q</p>", mode: "replace" },
      { type: "ui_render", id: "quiz-1", html: "<p>feedback</p>", mode: "replace" },
    ])
    expect(model.canvas).toHaveLength(1)
    expect(model.canvas[0]?.html).toBe("<p>feedback</p>")
    const patches = allPatches.filter((p) => p.kind === "canvas")
    expect(patches).toHaveLength(2)
  })

  test("the root's own health stamps never mint a chip — they feed the activity strip", () => {
    const { model, allPatches } = run([
      { type: "agent_health", nodeId: ROOT, state: "waiting-on-agents", lastActivityAt: 1 },
    ])
    expect(model.agents).toHaveLength(0)
    expect(model.activity.label).toBe("waiting-on-agents")
    expect(allPatches.some((p) => p.kind === "activity")).toBe(true)
  })

  test("activity: idle→busy stamps the clock + patches; tool start sets the label, end clears it; idle clears all", () => {
    const reduce = makeWebReducer(ROOT, () => 1234)
    let model = emptyModel({ phase: "idle", openToolCount: 0 })
    const all: Array<{ kind: string }> = []
    const step = (e: AgentEvent): void => {
      const r = reduce(model, e)
      model = r.model
      all.push(...r.patches)
    }
    step({ type: "turn_start", turnIndex: 0 })
    expect(model.activitySince).toBe(1234)
    expect(all.some((p) => p.kind === "activity")).toBe(true)
    step({ type: "tool_call_start", turnIndex: 0, id: "c1", toolName: "read_file", args: { path: "src/x.ts" } })
    expect(model.activity.label).toMatch(/Read/)
    step({ type: "tool_call_end", turnIndex: 0, id: "c1", toolName: "read_file", ok: true, result: { path: "src/x.ts", content: "    1\tx", totalLines: 1, truncated: false } })
    expect(model.activity.label).toBeUndefined()
    step({ type: "agent_end", finalText: "done" })
    expect(model.phase.phase).toBe("idle")
    expect(model.activitySince).toBeUndefined()
  })

  test("a derived workspace card links its pill via refIds (click-to-open)", () => {
    const { model } = run([
      { type: "tool_call_start", turnIndex: 0, id: "c1", toolName: "read_file", args: { path: "src/a.ts" } },
      { type: "tool_call_end", turnIndex: 0, id: "c1", toolName: "read_file", ok: true, result: { path: "src/a.ts", content: "    1\tx", totalLines: 1, truncated: false } },
    ])
    expect(model.refIds["c1"]).toBe("ws-file-src_2Fa_2Ets")
  })

  test("ui_render focus: new page focuses; background update doesn't; active:true pulls", () => {
    const { model, allPatches } = run([
      { type: "ui_render", id: "a", html: "<p>a</p>", mode: "replace" },
      { type: "ui_render", id: "b", html: "<p>b</p>", mode: "replace", active: false },
      { type: "ui_render", id: "b", html: "<p>b2</p>", mode: "replace", active: true },
    ])
    expect(model.activePage).toBe("b")
    const canvas = allPatches.filter((p) => p.kind === "canvas") as Array<{ kind: string; focus: boolean }>
    expect(canvas.map((p) => p.focus)).toEqual([true, false, true])
  })

  test("approval events set and clear the sheet", () => {
    const { model } = run([
      { type: "approval_needed", tool: "Bash", summary: "rm -rf x", cwd: "/w", ruleKey: "bash:rm" },
    ])
    expect(model.approval?.summary).toBe("rm -rf x")
    const cleared = run([
      { type: "approval_needed", tool: "Bash", summary: "rm -rf x", cwd: "/w", ruleKey: "bash:rm" },
      { type: "approval_resolved" },
    ])
    expect(cleared.model.approval).toBeUndefined()
  })

  test("phase follows root events (header patches), sub-agent events don't move it", () => {
    const { model, allPatches } = run([
      { type: "turn_start", turnIndex: 0 },
      { type: "tool_call_start", turnIndex: 0, id: "c9", toolName: "grep", args: {}, nodeId: "n1" },
    ])
    expect(model.phase.phase).toBe("thinking")
    expect(allPatches.filter((p) => p.kind === "header").length).toBeGreaterThanOrEqual(1)
    const ended = run([
      { type: "turn_start", turnIndex: 0 },
      { type: "agent_end", finalText: "done" },
    ])
    expect(ended.model.phase.phase).toBe("idle")
  })
})
